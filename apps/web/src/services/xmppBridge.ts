/**
 * xmppBridge.ts
 * Wires XMPP adapter events into Zustand stores and the notification system.
 * Call initXmppBridge(client) after connecting each account.
 */

import { getClient, XmppClient, RosterContact as AdapterContact } from "./xmppAdapter";
import { restoreXmppPush } from "./push";
import toast from "react-hot-toast";
import { useRosterStore } from "@/stores/rosterStore";
import { retractionMatchesMessage, useChatStore } from "@/stores/chatStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { useAccountStore } from "@/stores/accountStore";
import { useGroupStore } from "@/stores/groupStore";
import { initCrossDeviceSync } from "@/services/crossDeviceSync";
import { initSearchIndex, indexMessage, removeFromIndex } from "@/services/searchIndex";
import { applyMessageRetraction } from "@/services/messageRetraction";
import { callManager, JingleSession } from "@/services/jingle";
import {
  sdpToJingleXml,
  jingleXmlToSdp,
  candidateToJingleXml,
  terminateToJingleXml,
} from "@/services/jingle/sdpToJingle";
import {
  initOmemo,
  initializeOmemoKeys,
  decryptEnvelope,
  encryptForDevices,
  buildOwnBundle,
  establishSession,
} from "@/services/omemo";
import { OmemoStore } from "@/services/omemo/store";
import { cacheMessages, deleteLocalConversationData } from "./localDb";
import { isMessageWithinRetention } from "./historyRetention";
import { generateConversationId, isValidBareJid, normalizeBareJid, normalizeValidBareJid } from "@/utils/helpers";
import {
  parseKeyExchangePayload,
  storePeerPublicKey,
  decryptOmemoEnvelopeFromPeer,
  decryptBodyFromPeer,
  getOrCreateLocalDeviceId,
  getOrCreateLocalOmemoBundle,
  isEncryptedPayload,
  storePeerOmemoBundle,
} from "@/services/e2ee";

const SUB_REQUEST_DEDUPE_MS = 10 * 60 * 1000;
const lastSubscriptionRequestAt = new Map<string, number>();
const avatarFetchInFlight = new Set<string>();
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function normalizePresence(show?: string): "available" | "away" | "dnd" | "xa" | "unavailable" {
  const value = (show ?? "").toLowerCase();
  if (value === "away") return "away";
  if (value === "dnd") return "dnd";
  if (value === "xa") return "xa";
  if (value === "unavailable" || value === "offline") return "unavailable";
  return "available";
}

/** Resolve an archived MUC sender when Prosody omits the occupant's real JID. */
async function resolveGroupOmemoSender(
  client: XmppClient,
  roomJid: string,
  nickname: string,
  senderDeviceId: number,
  preferredJid?: string,
): Promise<string | null> {
  const preferred = normalizeValidBareJid(preferredJid ?? "");
  if (preferred && preferred !== roomJid) return preferred;
  try {
    // The room is already checked as members-only and non-anonymous by this
    // method. Device IDs belong to accounts, not to room nicknames.
    const { jids } = await client.fetchMucOmemoMembers(roomJid);
    const matches = (await Promise.all(jids.map(async (jid) => {
      const devices = await client.fetchOmemoDeviceList(jid).catch((): number[] => []);
      return devices.includes(senderDeviceId) ? jid : null;
    }))).filter((jid): jid is string => Boolean(jid));
    if (matches.length === 1) return matches[0];
    const nickMatches = matches.filter((jid) => jid.split("@")[0] === nickname.toLowerCase());
    return nickMatches.length === 1 ? nickMatches[0] : null;
  } catch {
    return null;
  }
}

export function initXmppBridge(client: XmppClient) {
  const accountId = client.config.accountId;
  const ownBareJid = normalizeBareJid(client.config.jid);

  // Connection changes
  client.on("connection.changed", (data: any) => {
	console.debug("[XMPP] connection.changed:", data);
    useAccountStore.getState().setConnected(accountId, data.status === "connected" || data.status === "verified");
    if (data.status !== "connected" && data.status !== "verified") {
      const store = useChatStore.getState();
      Object.values(store.conversations)
        .filter((c) => c.accountId === accountId)
        .forEach((c) => store.setTypingPeer(c.id, null, false));
    }
    if (data.status === "connected" || data.status === "online" || data.status === "authenticated") {
      if (data.status === "connected") {
        void restoreXmppPush(accountId).catch((error) => {
          console.warn("[Push] XMPP registration failed", error);
        });
        void client.fetchIceServers().then((servers) => {
          if (servers.length) callManager.setIceServers(accountId, servers);
        }).catch(() => {});
      }
      const publishLocalOmemo = async () => {
        try {
          console.debug("[OMEMO] init/publish start", { accountId });

          const { deviceId: localDeviceId } = await initializeOmemoKeys(accountId);
          console.debug("[OMEMO] libsignal local device id:", localDeviceId);

          const ownBundle = await buildOwnBundle(accountId);
          const localBundle = {
            deviceId: ownBundle.deviceId,
            signedPreKeyId: ownBundle.signedPreKeyId,
            signedPreKeyPublic: arrayBufferToBase64(ownBundle.signedPreKey),
            signedPreKeySignature: arrayBufferToBase64(ownBundle.signedPreKeySignature),
            identityKey: arrayBufferToBase64(ownBundle.identityKey),
            preKeys: ownBundle.preKeys.map((key) => ({
              preKeyId: key.keyId,
              value: arrayBufferToBase64(key.publicKey),
            })),
          };

          console.debug("[OMEMO] libsignal bundle ready:", {
            deviceId: localBundle.deviceId,
            preKeys: localBundle.preKeys?.length ?? 0,
          });

          console.debug("[OMEMO] publishing standard device list...");
          await client.publishOmemoDeviceList([localDeviceId]);
          console.debug("[OMEMO] standard device list published");

          console.debug("[OMEMO] publishing standard bundle...");
          await client.publishOmemoBundle(localBundle);
          console.debug("[OMEMO] standard bundle published");

          console.debug("[OMEMO] init/publish success");
        } catch (e) {
          console.error("[OMEMO] init/publish failed:", e);
        }
      };
      void publishLocalOmemo();

      // KILLER-07: build local full-text search index from cached messages
      void initSearchIndex(accountId).catch(() => {});

      // KILLER-04: bootstrap cross-device sync from PEP private node
      void (async () => {
        try {
          const sync = initCrossDeviceSync(accountId, client);
          const remote = await sync.pullSnapshot();
          if (!remote) return;
          const store = useChatStore.getState();
          // Apply remote starred IDs (additive)
          if (remote.starred) {
            for (const msgId of remote.starred) {
              for (const convMsgs of Object.values(store.messages)) {
                const msg = convMsgs.find((m) => m.id === msgId);
                if (msg && !msg.starred) {
                  store.toggleMessageStar(msg.conversationId, msgId);
                }
              }
            }
          }
          // Apply pinned conversations
          if (remote.pinned) {
            for (const convId of remote.pinned) {
              const conv = store.conversations[convId];
              if (conv && !conv.pinned) {
                store.upsertConversation({ ...conv, pinned: true });
              }
            }
          }
          // Apply meta-contact groupings
          if (remote.metaContacts) {
            try {
              const { useMetaContactStore } = await import("@/services/metaContacts");
              const metaStore = useMetaContactStore.getState();
              // Merge remote into local (additive)
              const remoteMetas = remote.metaContacts.metas as Record<string, any>;
              if (remoteMetas) {
                for (const [id, meta] of Object.entries(remoteMetas)) {
                  if (!metaStore.metas[id]) {
                    metaStore.metas[id] = meta;
                  }
                }
              }
            } catch {}
          }
        } catch {
          // Cross-device sync degrades gracefully if PEP unavailable
        }
      })();
    }
  });

  // Roster updates -> RosterStore
  client.on("roster.updated", (data: any) => {
    const { contacts }: { contacts: AdapterContact[] } = data;
    contacts.forEach((c) => {
      if (!c.jid) return;
      const normalizedJid = normalizeBareJid(c.jid);
      if (!isValidBareJid(normalizedJid)) return;
      if (normalizedJid === ownBareJid) return;
      const existing = useRosterStore.getState().getContact(accountId, normalizedJid);
      useRosterStore.getState().upsertContact({
        accountId,
        jid: normalizedJid,
        name: c.name ?? existing?.name,
        groups: c.groups?.length ? c.groups : (existing?.groups ?? []),
        subscription: c.subscription as any,
        pendingIncoming: c.subscription === "none" ? (existing?.pendingIncoming ?? false) : false,
        presence: existing?.presence ?? "unavailable",
        statusText: existing?.statusText,
        avatarUrl: existing?.avatarUrl,
        isBlocked: existing?.isBlocked ?? false,
      });

      const avatarKey = `${accountId}::${normalizedJid}`;
      if (!existing?.avatarUrl && !avatarFetchInFlight.has(avatarKey)) {
        avatarFetchInFlight.add(avatarKey);
        client.fetchVCardAvatar(normalizedJid).then((avatarUrl) => {
          if (avatarUrl) {
            const latest = useRosterStore.getState().getContact(accountId, normalizedJid);
            if (latest) {
              useRosterStore.getState().upsertContact({ ...latest, avatarUrl });
            }
          }
        }).finally(() => {
          avatarFetchInFlight.delete(avatarKey);
        });
      }

      const syncPeerOmemo = async () => {
        try {
          const devices = await client.fetchOmemoDeviceList(normalizedJid);
          for (const deviceId of devices) {
            const bundle = await client.fetchOmemoBundle(normalizedJid, deviceId);
            if (bundle) {
              await storePeerOmemoBundle(accountId, normalizedJid, bundle);
            }
          }
        } catch {
          // no-op; fallback handshake remains available
        }
      };
      void syncPeerOmemo();

      // Standard flow: rely on published OMEMO device list + bundles (no private key-exchange stanzas).
    });
  });

  client.on("subscription.request", (data: any) => {
    const jid = data.jid as string;
    if (!jid) return;
    const normalizedJid = normalizeValidBareJid(jid);
    if (!normalizedJid) return;
    if (normalizedJid === ownBareJid) return;
    const dedupeKey = `${accountId}::${normalizedJid}`;
    const now = Date.now();
    const lastAt = lastSubscriptionRequestAt.get(dedupeKey) ?? 0;
    if (now - lastAt < SUB_REQUEST_DEDUPE_MS) return;
    lastSubscriptionRequestAt.set(dedupeKey, now);

    const existing = useRosterStore.getState().getContact(accountId, normalizedJid);
    const alreadySubscribed =
      existing?.subscription === "both"
      || existing?.subscription === "to"
      || existing?.subscription === "from";
    if (existing?.isBlocked || existing?.pendingIncoming || alreadySubscribed) return;
    useRosterStore.getState().markPendingIncoming(accountId, normalizedJid);
    useNotificationStore.getState().addNotification({
      type: "system",
      title: "Subscription request",
      body: `${normalizedJid} wants to add you`,
      accountId,
    });
  });

  client.on("subscription.approved", (data: any) => {
    const normalizedJid = normalizeValidBareJid(data.jid as string);
    if (!normalizedJid) return;
    if (normalizedJid === ownBareJid) return;
    const existing = useRosterStore.getState().getContact(accountId, normalizedJid);
    useRosterStore.getState().upsertContact({
      accountId,
      jid: normalizedJid,
      name: existing?.name,
      groups: existing?.groups ?? [],
      subscription: "both",
      pendingIncoming: false,
      presence: existing?.presence ?? "unavailable",
      statusText: existing?.statusText,
      avatarUrl: existing?.avatarUrl,
      isBlocked: false,
    });
    useNotificationStore.getState().addNotification({
      type: "system",
      title: "Friend request accepted",
      body: `${normalizedJid} accepted your friend request`,
      accountId,
    });
  });

  client.on("subscription.denied", (data: any) => {
    const normalizedJid = normalizeValidBareJid(data.jid as string);
    if (!normalizedJid) return;
    if (normalizedJid === ownBareJid) return;
    const convId = generateConversationId(accountId, normalizedJid);
    const existing = useRosterStore.getState().getContact(accountId, normalizedJid);
    if (existing) {
      useRosterStore.getState().upsertContact({
        ...existing,
        accountId,
        jid: normalizedJid,
        subscription: "none",
        pendingIncoming: false,
      });
    }
    useChatStore.getState().deleteConversation(convId);
    deleteLocalConversationData(convId).catch(() => {});
    useNotificationStore.getState().addNotification({
      type: "system",
      title: "Friend request rejected",
      body: `${normalizedJid} rejected your friend request`,
      accountId,
    });
  });

  // Presence updates -> RosterStore
  client.on("presence.updated", (data: any) => {
    const { jid, show, status } = data;
    const normalizedJid = normalizeValidBareJid(jid);
    if (!normalizedJid) return;
    if (normalizedJid === ownBareJid) return;
    const roster = useRosterStore.getState();
    if (!roster.getContact(accountId, normalizedJid)) {
      roster.upsertContact({
        accountId,
        jid: normalizedJid,
        groups: [],
        subscription: "none",
        pendingIncoming: false,
        presence: normalizePresence(show),
        statusText: status,
        isBlocked: false,
      });
      return;
    }
    roster.updatePresence(accountId, normalizedJid, normalizePresence(show), status);
  });

  // Incoming messages -> ChatStore + notifications
  client.on("message.received", async (data: any) => {
    const { message, isCarbonSent, isCarbonReceived } = data;
    const from = normalizeBareJid(message.from);
    const to = normalizeBareJid(message.to ?? "");
    const fromDomain = (from.split("@")[1] ?? "").toLowerCase();
    const isConferenceJid = fromDomain.startsWith("conference.") || fromDomain.includes(".conference.");
    const isGroupContext = message.type === "groupchat" || isConferenceJid;
    const roomNickname = isGroupContext ? String(message.from).split("/")[1] ?? "" : "";
    const roomMember = isGroupContext ? (useGroupStore.getState().members[`${accountId}::${from}`] ?? [])
      .find((member) => member.nickname === roomNickname) : undefined;
    let cryptoSender = isGroupContext
      ? normalizeBareJid(message.realSenderJid || roomMember?.jid || "")
      : from;
    if (!isValidBareJid(from) && message.type !== "groupchat") return;

    // XEP-0280 Carbon: this is a copy of a message we sent from another device
    // Build outgoing message and add to the peer's conversation
    if (isCarbonSent) {
      const peerJid = to;
      if (!isValidBareJid(peerJid) || peerJid === ownBareJid) return;
      const convId = generateConversationId(accountId, peerJid);
      const existingConv = useChatStore.getState().conversations[convId];
      if (!existingConv) {
        const contact = useRosterStore.getState().getContact(accountId, peerJid);
        useChatStore.getState().upsertConversation({
          id: convId,
          accountId,
          type: "private",
          peerJid,
          title: contact?.name ?? peerJid.split("@")[0],
          unreadCount: 0,
          pinned: false,
        });
      }
      const carbonMsg = {
        id: message.id,
        conversationId: convId,
        senderJid: ownBareJid,
        body: message.body,
        bodyType: "text" as const,
        direction: "out" as const,
        status: "sent" as const,
        timestamp: message.timestamp,
        replyToId: message.replyTo,
        encrypted: Boolean(message.omemo) || (typeof message.body === "string" && isEncryptedPayload(message.body)),
      };
      // Avoid duplicates if we already added this message locally before sending
      const existing = useChatStore.getState().messages[convId]?.find((m) => m.id === message.id);
      if (!existing) {
        useChatStore.getState().addMessage(carbonMsg);
        cacheMessages([carbonMsg]).catch(() => {});
      }
      return;
    }

    // For carbon-received: treat exactly like a normal incoming message
    // (the rest of the handler below already handles it correctly)

    if (from === ownBareJid && !isCarbonReceived) return;
    const existingContact = useRosterStore.getState().getContact(accountId, from);
    if (existingContact?.isBlocked) return;

    if (!existingContact && !isGroupContext) {
      useRosterStore.getState().upsertContact({
        accountId,
        jid: from,
        groups: [],
        subscription: "none",
        pendingIncoming: true,
        presence: "unavailable",
        isBlocked: false,
      });
    }

    // Find or create conversation
    const convId = generateConversationId(accountId, from);
    if (isGroupContext && useChatStore.getState().messages[convId]?.some((m) => m.id === message.id)) {
      if (message.stanzaId) useChatStore.getState().updateMessage(convId, message.id, { stanzaId: message.stanzaId, occupantJid: message.from });
      return;
    }
    const existingConv = useChatStore.getState().conversations[convId];

    if (!existingConv) {
      const contact = useRosterStore.getState().getContact(accountId, from);
      useChatStore.getState().upsertConversation({
        id: convId,
        accountId,
        type: isGroupContext ? "group" : "private",
        peerJid: from,
        title: contact?.name ?? from.split("@")[0],
        unreadCount: 0,
        pinned: false,
      });
    }

    let incomingBody = message.body;
    const incomingOmemo = message.omemo;
    if (typeof incomingBody === "string") {
      const keyExchange = parseKeyExchangePayload(incomingBody.trim());
      if (keyExchange) {
        await storePeerPublicKey(accountId, from, keyExchange);
        // Handshake control stanza: store key material, don't render as chat content.
        return;
      }
    }
    const incomingEncrypted = Boolean(incomingOmemo) || (typeof incomingBody === "string" && isEncryptedPayload(incomingBody));
    let decryptFailed = false;
    let decryptFailReason = "";
    if (incomingOmemo) {
      // The body coming from xmppAdapter is the OMEMO fallback hint (per XEP-0384).
      // We must NEVER display this as the message — discard it now, before any
      // decrypt attempt, so even if everything below fails the user never sees
      // "I sent you an OMEMO encrypted message but your client doesn't seem to support that".
      incomingBody = "";
      if (isGroupContext && (!isValidBareJid(cryptoSender) || cryptoSender.endsWith(`@${from}`))) {
        cryptoSender = await resolveGroupOmemoSender(
          client, from, roomNickname, incomingOmemo.sid, cryptoSender,
        ) ?? "";
      }
      if (isGroupContext && (!cryptoSender || !isValidBareJid(cryptoSender) || cryptoSender.endsWith(`@${from}`))) {
        incomingBody = "🔒 Encrypted group message — sender's account is unavailable.";
        decryptFailed = true;
      } else {

      // BTBV: detect new peer device and notify user
      try {
        const senderDevId = incomingOmemo.sid;
        const trustKey = `liaot-omemo-trust:${accountId}:${cryptoSender}:${senderDevId}`;
        if (senderDevId && !localStorage.getItem(trustKey)) {
          // First time seeing this device - flag as auto-trusted (BTBV)
          localStorage.setItem(trustKey, "trusted");
          // If peer already has other devices, this is a NEW device - warn
          const otherDevicePattern = `liaot-omemo-trust:${accountId}:${cryptoSender}:`;
          let otherCount = 0;
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(otherDevicePattern) && k !== trustKey) otherCount++;
          }
          if (otherCount > 0) {
            const sysMsg = {
              id: crypto.randomUUID(),
              conversationId: generateConversationId(accountId, from),
              senderJid: "system",
              body: `⚠ ${cryptoSender.split("@")[0]} added a new device (#${senderDevId}). Verify their fingerprint in the trust panel.`,
              bodyType: "text" as const,
              direction: "system" as const,
              status: "delivered" as const,
              timestamp: Date.now(),
            };
            useChatStore.getState().addMessage(sysMsg);
          }
        }
      } catch {}

      // Try the standard libsignal-based decryption first (for messages
      // from Conversations / Gajim / Movim using XEP-0384 v0.8+).
      let decrypted: string | null = null;
      let libsignalErr: unknown = null;
      try {
        const store = new OmemoStore(accountId);
        const localDeviceId = await store.getLocalRegistrationId();
        if (!localDeviceId) {
          decryptFailReason = "no-local-device";
        } else if (!incomingOmemo.namespace?.includes("axolotl")) {
          decryptFailReason = `unknown-namespace:${incomingOmemo.namespace}`;
        } else {
          // Convert legacy envelope format to new EncryptedEnvelope
          const ourKey = incomingOmemo.keys.find((k: any) => k.rid === localDeviceId);
          if (!ourKey) {
            decryptFailReason = `no-key-for-our-device(localDevId=${localDeviceId},availableRids=${incomingOmemo.keys.map((k: any) => k.rid).join(",")})`;
          } else {
            const newEnvelope = {
              sid: incomingOmemo.sid,
              iv: base64ToArrayBuffer(incomingOmemo.iv),
              payload: base64ToArrayBuffer(incomingOmemo.payload),
              keys: incomingOmemo.keys.map((k: any) => ({
                rid: k.rid,
                isPreKey: k.prekey === true,
                body: base64ToArrayBuffer(k.value),
              })),
            };
            decrypted = await decryptEnvelope(accountId, localDeviceId, cryptoSender, newEnvelope);
          }
        }
      } catch (e) {
        libsignalErr = e;
      }
      // Fall back to legacy custom-protocol decryption
      if (decrypted == null) {
        try {
          decrypted = await decryptOmemoEnvelopeFromPeer(accountId, cryptoSender, incomingOmemo);
        } catch (e) {
          // Both paths failed — record both error reasons for diagnostics
          if (!decryptFailReason) {
            decryptFailReason = `legacy-decrypt-error:${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
      if (decrypted == null) {
        // Structured log so admins can grep "omemo-decrypt-fail" and see why
        // eslint-disable-next-line no-console
        console.warn("[OMEMO] omemo-decrypt-fail", {
          from: cryptoSender,
          accountId,
          senderDevId: incomingOmemo.sid,
          namespace: incomingOmemo.namespace,
          reason: decryptFailReason || "unknown",
          libsignalErr: libsignalErr instanceof Error ? libsignalErr.message : libsignalErr,
        });
        // User-facing message — clearly distinguish "no key for us" vs other failures
        if (decryptFailReason.startsWith("no-key-for-our-device")) {
          incomingBody = "🔒 Encrypted message — sender doesn't know your device key yet. Send them any message so they can sync.";
        } else if (decryptFailReason.startsWith("no-local-device")) {
          incomingBody = "🔒 Encrypted message — your local OMEMO key is missing. Re-login may help.";
        } else {
          incomingBody = "🔒 Encrypted message — unable to decrypt. Verify both devices' OMEMO trust.";
        }
        decryptFailed = true;
      } else {
        incomingBody = decrypted;
      }
      }
    } else if (incomingEncrypted) {
      const decrypted = await decryptBodyFromPeer(accountId, from, incomingBody);
      if (decrypted == null) {
        incomingBody = "🔒 Encrypted message — unable to decrypt";
        decryptFailed = true;
      } else {
        incomingBody = decrypted;
      }
    }

    const chatMsg = {
      id: message.id,
      conversationId: convId,
      senderJid: isGroupContext && isValidBareJid(cryptoSender) && !cryptoSender.endsWith(`@${from}`)
        ? cryptoSender : from,
      body: incomingBody,
      bodyType: "text" as const,
      direction: "in" as const,
      status: "delivered" as const,
      timestamp: message.timestamp,
      encrypted: incomingEncrypted,
      decryptFailed,
      cipherPayload: incomingOmemo ? undefined : (incomingEncrypted ? String(message.body) : undefined),
      omemoEnvelope: incomingOmemo ?? undefined,
      replyToId: message.replyTo,
      stanzaId: message.stanzaId,
      occupantJid: isGroupContext ? message.from : undefined,
    };

    if (message.replaceId) {
      useChatStore.getState().updateMessage(convId, message.replaceId, {
        body: incomingBody,
        editedAt: message.timestamp,
      });
      cacheMessages([
        {
          ...(useChatStore.getState().messages[convId]?.find((m) => m.id === message.replaceId) ?? chatMsg),
          body: incomingBody,
          editedAt: message.timestamp,
        },
      ]).catch(() => {});
      return;
    }

    useChatStore.getState().addMessage(chatMsg);
    client.sendReceipt(message.from, message.id, "received");
    if (useChatStore.getState().activeConversationId === convId) {
      client.sendReceipt(message.from, message.id, "displayed");
    }

    // Cache to IndexedDB
    cacheMessages([chatMsg]).catch(() => {});

    // A retraction may have arrived before this message during MAM replay.
    const storedMessage = useChatStore.getState().messages[convId]?.find((m) => m.id === message.id);
    if (!storedMessage || storedMessage.deletedAt) return;

    // KILLER-07: index for offline full-text search
    indexMessage(accountId, chatMsg.conversationId, chatMsg);

    // ====================================================
    // @ai mention auto-response
    // If the message starts with @ai or contains "@ai " in a group/private chat,
    // call the backend AI assistant and post the reply as a system message.
    // ====================================================
    {
      const trimmed = (incomingBody ?? "").trim();
      const aiTrigger = /(^|\s)@ai(\s|$)/i;
      if (aiTrigger.test(trimmed)) {
        const prompt = trimmed.replace(/(^|\s)@ai(\s|$)/i, " ").trim();
        if (prompt) {
          // Collect last 10 messages of context
          const allMsgs = useChatStore.getState().messages[convId] ?? [];
          const contextMessages = allMsgs.slice(-10).map(
            (m) => `${m.senderJid.split("@")[0]}: ${m.body}`
          );
          (async () => {
            try {
              const resp = await fetch("/api/ai/assistant", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  prompt,
                  context_messages: contextMessages,
                  conversation_id: convId,
                  persona: "concise",
                }),
              });
              if (!resp.ok) return;
              const data = await resp.json();
              const aiMsg = {
                id: crypto.randomUUID(),
                conversationId: convId,
                senderJid: "ai-assistant",
                body: `🤖 ${data.reply}`,
                bodyType: "text" as const,
                direction: "system" as const,
                status: "delivered" as const,
                timestamp: Date.now(),
              };
              useChatStore.getState().addMessage(aiMsg);
              cacheMessages([aiMsg]).catch(() => {});
            } catch {
              // AI unavailable; silently skip
            }
          })();
        }
      }
    }

    // Notification
    const contact = useRosterStore.getState().getContact(accountId, from);
    const activeConvId = useChatStore.getState().activeConversationId;
    const ownUsername = ownBareJid.split("@")[0].toLowerCase();
    const text = (message.body ?? "").toLowerCase();
    const mentionEnabled = localStorage.getItem("liaot-notify-mention") !== "0";
    const mentioned = text.includes(`@${ownUsername}`);
    if (activeConvId !== convId) {
      useNotificationStore.getState().addNotification({
        type: mentioned && mentionEnabled ? "mention" : "message",
        title: contact?.name ?? from.split("@")[0],
        body: message.body.slice(0, 80),
        conversationId: convId,
        accountId,
      });
    } else if (mentioned && mentionEnabled) {
      useNotificationStore.getState().addNotification({
        type: "mention",
        title: `${contact?.name ?? from.split("@")[0]} mentioned you`,
        body: message.body.slice(0, 80),
        conversationId: convId,
        accountId,
      });
    }
  });

  // MAM history messages
  client.on("mam.message", async (data: any) => {
    const { message } = data;
    const from = normalizeBareJid(message.from);
    const ownJid = normalizeBareJid(client.config.jid);
    const isGroup = message.type === "groupchat";
    let senderJid = isGroup ? normalizeBareJid(message.realSenderJid ?? "") : from;
    if (isGroup && message.omemo && !isValidBareJid(senderJid)) {
      senderJid = await resolveGroupOmemoSender(
        client, from, String(message.from).split("/")[1] ?? "", message.omemo.sid, senderJid,
      ) ?? "";
    }
    const isOwn = senderJid === ownJid;
    const peerJid = isGroup ? from : isOwn ? normalizeBareJid(message.to) : from;
    if (!isValidBareJid(peerJid) || peerJid === ownJid) return;
    const convId = generateConversationId(accountId, peerJid);
    if (useChatStore.getState().messages[convId]?.some((m) => m.id === message.id)) return;
    if (!isMessageWithinRetention(message.timestamp)) return;
    // Deleting a conversation must not be undone by an old server archive page.
    if (message.timestamp <= (useChatStore.getState().clearedBefore?.[convId] ?? 0)) return;

    let body = message.body;
    const incomingOmemo = message.omemo;
    if (typeof body === "string") {
      const keyExchange = parseKeyExchangePayload(body.trim());
      if (keyExchange) {
        await storePeerPublicKey(accountId, peerJid, keyExchange);
        return;
      }
    }
    const encrypted = Boolean(incomingOmemo) || (typeof body === "string" && isEncryptedPayload(body));
    let decryptFailed = false;
    if (incomingOmemo) {
      let decrypted: string | null = null;
      if (senderJid && isValidBareJid(senderJid) && incomingOmemo.namespace?.includes("axolotl")) {
        try {
          const store = new OmemoStore(accountId);
          const localDeviceId = await store.getLocalRegistrationId();
          if (localDeviceId) decrypted = await decryptEnvelope(accountId, localDeviceId, senderJid, {
            sid: incomingOmemo.sid,
            iv: base64ToArrayBuffer(incomingOmemo.iv),
            payload: base64ToArrayBuffer(incomingOmemo.payload),
            keys: incomingOmemo.keys.map((key: any) => ({
              rid: key.rid,
              isPreKey: key.prekey === true,
              body: base64ToArrayBuffer(key.value),
            })),
          });
        } catch { /* Fall through to the earlier OMEMO format. */ }
      }
      if (decrypted == null && senderJid && isValidBareJid(senderJid)) {
        decrypted = await decryptOmemoEnvelopeFromPeer(accountId, senderJid, incomingOmemo);
      }
      if (decrypted == null) {
        body = "[Encrypted message - unable to decrypt]";
        decryptFailed = true;
      } else {
        body = decrypted;
      }
    } else if (encrypted) {
      const decrypted = await decryptBodyFromPeer(accountId, peerJid, body);
      if (decrypted == null) {
        body = "[Encrypted message - unable to decrypt]";
        decryptFailed = true;
      } else {
        body = decrypted;
      }
    }

    const chatMsg = {
      id: message.id,
      conversationId: convId,
      senderJid: isGroup && senderJid ? senderJid : from,
      body,
      bodyType: "text" as const,
      direction: isOwn ? ("out" as const) : ("in" as const),
      status: "delivered" as const,
      timestamp: message.timestamp,
      encrypted,
      decryptFailed,
      cipherPayload: incomingOmemo ? undefined : (encrypted ? String(message.body) : undefined),
      omemoEnvelope: incomingOmemo ?? undefined,
      replyToId: message.replyTo,
      stanzaId: message.stanzaId,
      occupantJid: isGroup ? message.from : undefined,
    };

    useChatStore.getState().addMessage(chatMsg, { countAsUnread: false });
    cacheMessages([chatMsg]).catch(() => {});
  });

  // Typing indicators
  client.on("typing.started", (data: any) => {
    const from = normalizeBareJid(String(data.from ?? ""));
    if (!isValidBareJid(from) || from === ownBareJid) return;
    const convId = generateConversationId(accountId, from);
    const store = useChatStore.getState();
    store.setTypingPeer(convId, from, true);
    const prev = typingTimers.get(convId);
    if (prev) clearTimeout(prev);
    typingTimers.set(
      convId,
      setTimeout(() => {
        useChatStore.getState().setTypingPeer(convId, null, false);
        typingTimers.delete(convId);
      }, 5000)
    );
  });

  client.on("typing.stopped", (data: any) => {
    const from = normalizeBareJid(String(data.from ?? ""));
    if (!isValidBareJid(from) || from === ownBareJid) return;
    const convId = generateConversationId(accountId, from);
    const prev = typingTimers.get(convId);
    if (prev) {
      clearTimeout(prev);
      typingTimers.delete(convId);
    }
    useChatStore.getState().setTypingPeer(convId, null, false);
  });

  // Delivery receipts
  client.on("message.delivered", (data: any) => {
    const messageId = data.messageId as string | undefined;
    if (!messageId) return;
    const store = useChatStore.getState();
    const relevantConvIds = Object.values(store.conversations)
      .filter((c) => c.accountId === accountId)
      .map((c) => c.id);
    relevantConvIds.forEach((conversationId) => {
      const list = store.messages[conversationId] ?? [];
      if (list.some((m) => m.id === messageId && m.direction === "out")) {
        store.updateMessage(conversationId, messageId, { status: "delivered" });
      }
    });
  });

  client.on("message.read", (data: any) => {
    const messageId = data.messageId as string | undefined;
    if (!messageId) return;
    const store = useChatStore.getState();
    const relevantConvIds = Object.values(store.conversations)
      .filter((c) => c.accountId === accountId)
      .map((c) => c.id);
    relevantConvIds.forEach((conversationId) => {
      const list = store.messages[conversationId] ?? [];
      if (list.some((m) => m.id === messageId && m.direction === "out")) {
        store.updateMessage(conversationId, messageId, { status: "read" });
      }
    });
  });

  client.on("reaction.received", (data: any) => {
    const { messageId, emojis, from } = data as {
      messageId: string;
      emojis: string[];
      from: string;
    };
    if (!messageId) return;
    const store = useChatStore.getState();
    // Find the conversation this message belongs to (scoped to this account)
    const convIds = Object.values(store.conversations)
      .filter((c) => c.accountId === accountId)
      .map((c) => c.id);
    for (const convId of convIds) {
      const list = store.messages[convId] ?? [];
      const msg = list.find((m) => m.id === messageId);
      if (msg) {
        // Replace reactions from this sender with the new set
        const existing = { ...(msg.reactions ?? {}) };
        // Peer sends their full current reaction set; we merge by emoji count
        const updated: Record<string, number> = { ...existing };
        emojis.forEach((emoji) => {
          updated[emoji] = (updated[emoji] ?? 0) + 1;
        });
        store.updateMessage(convId, messageId, { reactions: updated });
        break;
      }
    }
  });

  client.on("message.retracted", (data: any) => {
    const messageId = data.messageId as string | undefined;
    if (!messageId) return;
    const from = String(data.from ?? "");
    const fromBare = normalizeBareJid(from);
    const type: "chat" | "groupchat" = data.type === "groupchat" ? "groupchat" : "chat";
    const peerJid = type === "groupchat"
      ? fromBare
      : fromBare === ownBareJid ? normalizeBareJid(String(data.to ?? "")) : fromBare;
    if (!isValidBareJid(peerJid) || (type === "chat" && peerJid === ownBareJid)) return;
    const conversationId = generateConversationId(accountId, peerJid);
    const store = useChatStore.getState();
    const request = { from, realSenderJid: data.realSenderJid as string | undefined, type, at: Date.now() };
    const original = (store.messages[conversationId] ?? []).find((message) =>
      (message.id === messageId || (type === "groupchat" && message.stanzaId === messageId))
      && retractionMatchesMessage(message, request)
    );
    if (original) {
      applyMessageRetraction(conversationId, original.id);
    } else {
      store.rememberRetraction(conversationId, messageId, request);
    }
  });

  client.on("room.member", (data: any) => {
    const roomJid = normalizeBareJid(data.roomJid as string);
    if (!roomJid) return;
    const members = useGroupStore.getState().members[`${accountId}::${roomJid}`] ?? [];
    const jid = normalizeBareJid(data.jid as string);
    const nextMember = {
      jid,
      nickname: (data.nickname as string) ?? jid.split("@")[0],
      role: (data.role as any) ?? "participant",
      affiliation: (data.affiliation as any) ?? "none",
      presence: (data.presence as any) ?? "available",
    };
    const without = members.filter((m) => m.jid !== jid);
    if (nextMember.presence === "unavailable") {
      useGroupStore.getState().setMembers(accountId, roomJid, without);
      return;
    }
    useGroupStore.getState().setMembers(accountId, roomJid, [...without, nextMember]);
  });

  client.on("room.subject", (data: any) => {
    const roomJid = normalizeBareJid(data.roomJid as string);
    if (!roomJid) return;
    useGroupStore.getState().updateRoomSubject(accountId, roomJid, String(data.subject ?? ""));
  });

  client.on("room.invite", (data: any) => {
    const roomJid = normalizeBareJid(data.roomJid as string);
    if (!roomJid) return;
    const groupStore = useGroupStore.getState();
    const existing = groupStore.getRoom(accountId, roomJid);
    const roomName = existing?.name ?? roomJid.split("@")[0];
    const nickname = client.config.jid.split("@")[0];
    groupStore.upsertRoom({
      accountId,
      jid: roomJid,
      name: roomName,
      nickname: existing?.nickname ?? nickname,
      description: existing?.description,
      memberCount: existing?.memberCount,
      isPublic: existing?.isPublic ?? false,
      joinState: existing?.joinState ?? "idle",
      subject: existing?.subject,
    });
    const inviterJid = normalizeBareJid((data.inviterJid as string) || "");
    const reason = String(data.reason ?? "").trim();
    useNotificationStore.getState().addNotification({
      type: "system",
      title: "Group invitation",
      body: `${inviterJid || "Someone"} invited you to ${roomJid}${reason ? `: ${reason}` : ""}`,
      accountId,
    });
  });

  // Server-confirmed join — flip joinState to "joined"
  client.on("room.joined", (data: any) => {
    const roomJid = normalizeBareJid(data.roomJid as string);
    if (!roomJid) return;
    const groupStore = useGroupStore.getState();
    const existing = groupStore.getRoom(accountId, roomJid);
    if (existing) {
      groupStore.setJoinState(accountId, roomJid, "joined");
    } else {
      // Joined a room not previously in store (e.g. from external link)
      groupStore.upsertRoom({
        accountId,
        jid: roomJid,
        name: roomJid.split("@")[0],
        nickname: data.nickname ?? client.config.jid.split("@")[0],
        isPublic: false,
        joinState: "joined",
      });
    }
  });

  // Server rejected the join (room doesn't exist, banned, password wrong, etc)
  client.on("room.join.failed", (data: any) => {
    const roomJid = normalizeBareJid(data.roomJid as string);
    if (!roomJid) return;
    const reason = `${data.condition ?? "unknown"}${data.code ? ` (${data.code})` : ""}`;
    useGroupStore.getState().setJoinState(accountId, roomJid, "error", { lastError: reason });
    useNotificationStore.getState().addNotification({
      type: "system",
      title: "Could not join group",
      body: `${roomJid}: ${reason}`,
      accountId,
    });
  });

  // Server kicked / banned / shut down — flip joinState and notify user
  client.on("room.removed", (data: any) => {
    const roomJid = normalizeBareJid(data.roomJid as string);
    if (!roomJid) return;
    const reason = String(data.reason ?? "removed");
    useGroupStore.getState().setJoinState(accountId, roomJid, "kicked", {
      lastRemovalReason: reason,
    });
    const reasonText = data.reasonText ? `: ${data.reasonText}` : "";
    const actor = data.actor ? ` by ${data.actor}` : "";
    useNotificationStore.getState().addNotification({
      type: "system",
      title: "Removed from group",
      body: `${roomJid} (${reason}${actor}${reasonText})`,
      accountId,
    });
  });

  // Room was destroyed by its owner
  client.on("room.destroyed", (data: any) => {
    const roomJid = normalizeBareJid(data.roomJid as string);
    if (!roomJid) return;
    useGroupStore.getState().removeRoom(accountId, roomJid);
    useChatStore.getState().deleteConversation(generateConversationId(accountId, roomJid));
    void client.retractMucBookmark(roomJid).catch((error) =>
      console.warn(`[XMPP MUC] could not remove destroyed room bookmark ${roomJid}`, error));
    const altJid = data.altJid ? ` Replacement: ${data.altJid}` : "";
    const reasonText = data.reasonText ? `: ${data.reasonText}` : "";
    useNotificationStore.getState().addNotification({
      type: "system",
      title: "Group was destroyed",
      body: `${roomJid}${reasonText}${altJid}`,
      accountId,
    });
  });

  // After (re)connect, use server bookmarks before rejoining. Replaying every
  // persisted local room can recreate a group that its owner already dissolved.
  client.on("connection.changed", (data: any) => {
    if (data.status !== "connected") return;
    const groupStore = useGroupStore.getState();
    void client.fetchMucBookmarks().then((bookmarks) => {
      const bookmarkJids = new Set(bookmarks.map((bookmark) => bookmark.jid));
      for (const room of Object.values(groupStore.rooms)) {
        if (room.accountId !== accountId || bookmarkJids.has(room.jid)) continue;
        groupStore.removeRoom(accountId, room.jid);
        useChatStore.getState().deleteConversation(generateConversationId(accountId, room.jid));
      }
      for (const bookmark of bookmarks) {
        const existing = groupStore.getRoom(accountId, bookmark.jid);
        const nickname = bookmark.nickname || client.config.jid.split("@")[0];
        groupStore.upsertRoom({
          accountId,
          jid: bookmark.jid,
          name: bookmark.name,
          nickname,
          isPublic: existing?.isPublic ?? false,
          joinState: existing?.joinState ?? "idle",
        });
        const conversationId = generateConversationId(accountId, bookmark.jid);
        useChatStore.getState().upsertConversation({
          id: conversationId,
          accountId,
          type: "group",
          peerJid: bookmark.jid,
          title: bookmark.name,
          unreadCount: 0,
          pinned: false,
        });
        if (bookmark.autojoin) {
          groupStore.setJoinState(accountId, bookmark.jid, "joining");
          void client.joinRoom(bookmark.jid, nickname).catch((error) => {
            console.warn(`[XMPP MUC] bookmarked room join failed room=${bookmark.jid}`, error);
          });
        }
      }
    }).catch((error) => console.warn("[XMPP MUC] bookmarks unavailable", error));
  });

  // KILLER-04: Push local mutations to PEP cross-device sync (debounced)
  let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStarredHash = "";
  let lastPinnedHash = "";

  const triggerSync = async () => {
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(async () => {
      const { getCrossDeviceSync } = await import("@/services/crossDeviceSync");
      const sync = getCrossDeviceSync();
      if (!sync) return;
      const store = useChatStore.getState();
      const accountConvIds = new Set(
        Object.values(store.conversations)
          .filter((c) => c.accountId === accountId)
          .map((c) => c.id)
      );
      const starredIds: string[] = [];
      for (const [convId, msgs] of Object.entries(store.messages)) {
        if (!accountConvIds.has(convId)) continue;
        for (const m of msgs) if (m.starred) starredIds.push(m.id);
      }
      const starredHash = [...starredIds].sort().join(",");
      if (starredHash !== lastStarredHash) {
        lastStarredHash = starredHash;
        sync.pushStarred(starredIds).catch(() => {});
      }
      const pinnedIds = Object.values(store.conversations)
        .filter((c) => c.accountId === accountId && c.pinned)
        .map((c) => c.id);
      const pinnedHash = [...pinnedIds].sort().join(",");
      if (pinnedHash !== lastPinnedHash) {
        lastPinnedHash = pinnedHash;
        sync.pushPinned(pinnedIds).catch(() => {});
      }
    }, 1500);
  };

  // Jingle audio/video call handling
  client.on("jingle", async (data: any) => {
    const { from, sid, action, jingleEl } = data;
    if (!jingleEl) return;

    if (action === "session-initiate") {
      // Jingle also carries file transfers (XEP-0234). Never feed those
      // descriptions to WebRTC as if they were audio/video offers.
      const hasRtpDescription = Array.from(jingleEl.getElementsByTagNameNS("*", "description") as HTMLCollectionOf<Element>)
        .some((el) => el.namespaceURI === "urn:xmpp:jingle:apps:rtp:1" || el.getAttribute("xmlns") === "urn:xmpp:jingle:apps:rtp:1");
      if (!hasRtpDescription) {
        client.sendJingle(from, sid, terminateToJingleXml(sid, "unsupported-applications"));
        return;
      }
      // Incoming call - parse SDP from Jingle XML
      const contentEl = jingleEl.getElementsByTagNameNS("*", "content")[0];
      const senders = contentEl?.getAttribute("senders") ?? "both";
      // Determine media types from <description xmlns="urn:xmpp:jingle:apps:rtp:1" media="...">
      const descs = (Array.from(jingleEl.getElementsByTagNameNS("*", "description")) as Element[])
        .filter((el) =>
          el.namespaceURI === "urn:xmpp:jingle:apps:rtp:1"
          || el.getAttribute("xmlns") === "urn:xmpp:jingle:apps:rtp:1"
        );
      const mediaTypes: ("audio" | "video")[] = [];
      descs.forEach((d) => {
        const m = d.getAttribute("media");
        if (m === "audio" || m === "video") mediaTypes.push(m);
      });
      // For incoming we need the SDP - parse jingleEl into SDP string
      // This is a simplified path: in production we'd convert Jingle XML to SDP fully
      const sdp = jingleElToSdp(jingleEl);
      try {
        await callManager.handleIncoming(accountId, sid, from, mediaTypes, sdp);
      } catch (error) {
        // The IQ was acknowledged before WebRTC validated the offer. Tell the
        // caller why this session ended and surface a useful local diagnostic.
        client.sendJingle(from, sid, terminateToJingleXml(sid, "failed-application"));
        const name = error instanceof Error ? error.name : "Error";
        toast.error(`Incoming call could not be opened (${name}).`);
      }
    } else if (action === "session-accept") {
      const session = callManager.getSession(sid);
      if (!session || session.info.accountId !== accountId) return;
      const sdp = jingleElToSdp(jingleEl);
      await session.handleAnswer(sdp);
    } else if (action === "transport-info") {
      const session = callManager.getSession(sid);
      if (!session || session.info.accountId !== accountId) return;
      // A single transport-info can carry multiple ICE candidates. In
      // particular, the relay candidate may follow an unreachable host one.
      for (const cand of Array.from(jingleEl.getElementsByTagNameNS("*", "candidate")) as Element[]) {
        const relatedAddress = cand.getAttribute("rel-addr");
        const relatedPort = cand.getAttribute("rel-port");
        const candidateLine = `candidate:${cand.getAttribute("foundation")} ${cand.getAttribute("component")} ${cand.getAttribute("protocol")} ${cand.getAttribute("priority")} ${cand.getAttribute("ip")} ${cand.getAttribute("port")} typ ${cand.getAttribute("type")}` +
          (relatedAddress && relatedPort ? ` raddr ${relatedAddress} rport ${relatedPort}` : "");
        await session.addRemoteCandidate({
          candidate: candidateLine,
          sdpMid: cand.parentElement?.parentElement?.getAttribute("name") ?? "0",
        });
      }
    } else if (action === "session-terminate") {
      const session = callManager.getSession(sid);
      if (session?.info.accountId === accountId) {
        const reason = jingleEl.querySelector("reason")?.firstElementChild?.localName;
        if (reason && !["success", "decline", "busy", "cancel"].includes(reason)) {
          toast.error(`Call ended by peer (${reason}).`);
        }
        session.remoteHangup(reason);
      }
    }
  });

  client.on("jingle.error", (data: any) => {
    const session = callManager.getSession(data.sid);
    if (!session || session.info.accountId !== accountId) return;
    session.remoteHangup();
    toast.error(data.condition === "feature-not-implemented"
      ? "This contact's current client does not support calls."
      : `The call could not be connected (${data.condition ?? "unknown"}).`);
  });

  // Subscribe to outgoing Jingle stanzas from sessions
  // Subscribe to all sessions (both initiated locally and incoming) so
  // they can send Jingle stanzas back to the peer
  const subscribeSession = (session: JingleSession) => {
    if (session.info.accountId !== accountId) return;
    session.on("stanza.outgoing", (out: any) => {
      sendJingleStanza(client, session.info.peerJid, session.info.id, out);
    });
  };
  callManager.on("incoming", subscribeSession);
  callManager.on("started", subscribeSession);

  useChatStore.subscribe(() => { void triggerSync(); });
}

// Helper: convert incoming Jingle XML to SDP string (uses full converter)
function jingleElToSdp(jingleEl: Element): string {
  return jingleXmlToSdp(jingleEl);
}

// Helper: send an outgoing Jingle action (action, sdp/candidate/reason)
function sendJingleStanza(client: any, peerJid: string, sid: string, out: any) {
  let xml = "";
  const myJid = client.config?.jid ?? "";
  if (out.action === "session-initiate") {
    xml = sdpToJingleXml(out.sdp, "session-initiate", sid, myJid, peerJid);
  } else if (out.action === "session-accept") {
    xml = sdpToJingleXml(out.sdp, "session-accept", sid, peerJid, myJid);
  } else if (out.action === "transport-info" && out.candidate) {
    // Jingle content creator identifies who introduced the content in the
    // original session-initiate, not who gathered this ICE candidate.
    xml = candidateToJingleXml(sid, out.candidate, out.candidate.sdpMid ?? "0", "initiator");
  } else if (out.action === "session-terminate") {
    xml = terminateToJingleXml(sid, out.reason ?? "success");
  }
  if (xml && typeof client.sendJingle === "function") {
    client.sendJingle(peerJid, sid, xml);
  }
}


// Helper for converting OMEMO envelope between base64 and ArrayBuffer formats
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}


// =====================================================
// libsignal-based OMEMO encryption helper for outgoing messages
// =====================================================
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Try encrypting a message using the new libsignal-based OMEMO (XEP-0384 v0.8+).
 *
 * This is what Conversations / Gajim use. If the peer has published a bundle
 * to PEP via the standard axolotl namespaces, this path produces a real
 * interoperable OMEMO message.
 *
 * Returns the legacy OmemoEnvelope shape (so xmppAdapter.sendOmemoMessage
 * can serialize it without changes), or null if libsignal can't encrypt
 * (e.g. no session, no bundle, peer doesn't support OMEMO).
 *
 * Caller should fall back to the legacy custom protocol if this returns null.
 */
export async function tryLibsignalEncrypt(
  accountId: string,
  peerJid: string | string[],
  plaintext: string
): Promise<any | null> {
  const strictGroup = Array.isArray(peerJid);
  const peerJids = Array.isArray(peerJid) ? peerJid : [peerJid];
  try {
    const store = new OmemoStore(accountId);
    const ownDeviceId = await store.getLocalRegistrationId();
    if (!ownDeviceId) throw new Error("OMEMO keys are not ready on this device");

    const client = getClient(accountId);
    if (!client) throw new Error("XMPP is not connected");

    // 1. Discover peer's devices via PEP devicelist
    const NS_DEVICELIST = "eu.siacs.conversations.axolotl.devicelist";
    const NS_BUNDLES = "eu.siacs.conversations.axolotl.bundles";

    const ownJid = client.config?.jid?.split("/")[0]?.toLowerCase() ?? "";
    const allDevices: { peerJid: string; deviceId: number }[] = [];
    for (const recipientJid of peerJids) {
      if (recipientJid.toLowerCase() === ownJid) continue;
      const deviceListEl = await client.fetchPepNode(recipientJid, NS_DEVICELIST);
      if (!deviceListEl) throw new Error(`No OMEMO devices for ${recipientJid}`);

      const deviceIds: number[] = [];
      deviceListEl.querySelectorAll("device").forEach((dev: Element) => {
        const id = parseInt(dev.getAttribute("id") ?? "", 10);
        if (Number.isFinite(id) && id > 0) deviceIds.push(id);
      });
      if (deviceIds.length === 0) throw new Error(`No OMEMO devices for ${recipientJid}`);

      // Do not silently omit a member or one of their advertised devices.
      for (const deviceId of deviceIds) {
        const sessionExists = await store.loadSession(`${recipientJid}.${deviceId}`);
        if (sessionExists) {
          allDevices.push({ peerJid: recipientJid, deviceId });
          continue;
        }
        const bundleEl = await client.fetchPepNode(recipientJid, `${NS_BUNDLES}:${deviceId}`);
        if (!bundleEl) throw new Error(`OMEMO bundle unavailable for ${recipientJid}`);

      const identityKey = base64ToArrayBuffer(
        bundleEl.querySelector("identityKey")?.textContent?.trim() ?? ""
      );
      const signedPreKeyEl = bundleEl.querySelector("signedPreKeyPublic");
      const signedPreKeyId = parseInt(signedPreKeyEl?.getAttribute("signedPreKeyId") ?? "0", 10);
      const signedPreKey = base64ToArrayBuffer(signedPreKeyEl?.textContent?.trim() ?? "");
      const signedPreKeySignature = base64ToArrayBuffer(
        bundleEl.querySelector("signedPreKeySignature")?.textContent?.trim() ?? ""
      );
      // Pick a random one-time prekey
      const preKeyEls = bundleEl.querySelectorAll("preKeyPublic");
      let preKey: { keyId: number; publicKey: ArrayBuffer } | undefined;
      if (preKeyEls.length > 0) {
        const picked = preKeyEls[Math.floor(Math.random() * preKeyEls.length)] as Element;
        preKey = {
          keyId: parseInt(picked.getAttribute("preKeyId") ?? "0", 10),
          publicKey: base64ToArrayBuffer(picked.textContent?.trim() ?? ""),
        };
      }

      try {
        await establishSession(accountId, recipientJid, {
          deviceId,
          identityKey,
          signedPreKeyId,
          signedPreKey,
          signedPreKeySignature,
          preKey,
        });
      } catch {
        throw new Error(`Cannot establish OMEMO session with ${recipientJid}`);
      }
        allDevices.push({ peerJid: recipientJid, deviceId });
      }
    }

    // 3. Also discover OUR OWN other devices and establish sessions for them.
    //    XEP-0384 §4.2: a sender MUST encrypt the message key for every device
    //    of the recipient AND for every other device of the sender, otherwise
    //    the sender's other clients can't show the sent message.
    // Add own other devices (skip our own current device)
    if (ownJid) {
      try {
        const ownDeviceListEl = await client.fetchPepNode(ownJid, NS_DEVICELIST);
        if (!ownDeviceListEl && strictGroup) {
          throw new Error("Your OMEMO device list is unavailable");
        }
        if (ownDeviceListEl) {
          const ownDeviceIds: number[] = [];
          ownDeviceListEl.querySelectorAll("device").forEach((dev: Element) => {
            const id = parseInt(dev.getAttribute("id") ?? "", 10);
            if (Number.isFinite(id) && id !== ownDeviceId) ownDeviceIds.push(id);
          });

          for (const otherId of ownDeviceIds) {
            const sessExists = await store.loadSession(`${ownJid}.${otherId}`);
            if (!sessExists) {
              const ownBundleEl = await client.fetchPepNode(ownJid, `${NS_BUNDLES}:${otherId}`);
              if (!ownBundleEl) {
                if (strictGroup) throw new Error("An OMEMO bundle is unavailable for your other device");
                continue;
              }
              try {
                const identityKey = base64ToArrayBuffer(
                  ownBundleEl.querySelector("identityKey")?.textContent?.trim() ?? ""
                );
                const spkEl = ownBundleEl.querySelector("signedPreKeyPublic");
                const signedPreKeyId = parseInt(spkEl?.getAttribute("signedPreKeyId") ?? "0", 10);
                const signedPreKey = base64ToArrayBuffer(spkEl?.textContent?.trim() ?? "");
                const signedPreKeySignature = base64ToArrayBuffer(
                  ownBundleEl.querySelector("signedPreKeySignature")?.textContent?.trim() ?? ""
                );
                const pkEls = ownBundleEl.querySelectorAll("preKeyPublic");
                let preKey: { keyId: number; publicKey: ArrayBuffer } | undefined;
                if (pkEls.length > 0) {
                  const picked = pkEls[Math.floor(Math.random() * pkEls.length)] as Element;
                  preKey = {
                    keyId: parseInt(picked.getAttribute("preKeyId") ?? "0", 10),
                    publicKey: base64ToArrayBuffer(picked.textContent?.trim() ?? ""),
                  };
                }
                await establishSession(accountId, ownJid, {
                  deviceId: otherId,
                  identityKey, signedPreKeyId, signedPreKey, signedPreKeySignature, preKey,
                });
              } catch {
                if (strictGroup) throw new Error("Cannot establish OMEMO session with your other device");
                continue;
              }
            }
            allDevices.push({ peerJid: ownJid, deviceId: otherId });
          }
        }
      } catch (error) {
        if (strictGroup) throw error;
        // Own devicelist fetch failed — continue with peer-only encryption
        // (own other devices won't see this message, but peer will)
      }
    }

    // 4. Encrypt for all devices (peer + own other)
    if (allDevices.length === 0) throw new Error("No OMEMO recipients are available");
    const newEnvelope = await encryptForDevices(accountId, ownDeviceId, plaintext, allDevices);

    // 4. Convert new envelope shape to legacy shape (so existing sendOmemoMessage works)
    return {
      namespace: "eu.siacs.conversations.axolotl",
      sid: newEnvelope.sid,
      iv: arrayBufferToBase64(newEnvelope.iv),
      payload: arrayBufferToBase64(newEnvelope.payload),
      keys: newEnvelope.keys.map((k) => ({
        rid: k.rid,
        value: arrayBufferToBase64(k.body),
        prekey: k.isPreKey,
      })),
    };
  } catch (error) {
    if (strictGroup) throw error;
    return null;
  }
}

export async function encryptGroupOmemoMessage(accountId: string, roomJid: string, plaintext: string) {
  const client = getClient(accountId);
  if (!client?.connected) throw new Error("XMPP is not connected");
  const members = await client.fetchMucOmemoMembers(roomJid);
  return tryLibsignalEncrypt(accountId, members.jids, plaintext);
}


