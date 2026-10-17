/**
 * Full XMPP client wrapper for LyaoTalk.
 * Wraps Strophe.js with a clean event-driven API.
 */
import { normalizeBareJid, normalizeValidBareJid } from "@/utils/helpers";
import { parseXmppDelayTimestamp } from "@/utils/xmppDelay";
import type { IceServer } from "./jingle/types";

export interface XmppClientConfig {
  jid: string;
  password: string;
  wsUrl: string;
  accountId: string;

  /**
   * Stability tuning (all optional with sane defaults).
   * Defaults are calibrated for typical mobile/wifi conditions where some
   * NAT routers drop idle WebSockets after ~3 minutes.
   */
  /** ms between keep-alive ping IQs. Default 45000 (45s). */
  keepaliveIntervalMs?: number;
  /** ms to wait for ping IQ response before treating link as stalled. Default 20000. */
  keepaliveTimeoutMs?: number;
  /** ms between SM <r/> requests. Default 30000. */
  smRequestIntervalMs?: number;
}

export type XmppEvent =
  | "connection.changed"
  | "roster.updated"
  | "presence.updated"
  | "subscription.request"
  | "subscription.approved"
  | "subscription.denied"
  | "message.received"
  | "message.sent"
  | "room.joined"
  | "room.left"
  | "room.join.failed"
  | "room.removed"
  | "room.destroyed"
  | "mam.loaded"
  | "mam.message"
  | "omemo.error"
  | "upload.completed"
  | "typing.started"
  | "typing.stopped"
  | "message.delivered"
  | "message.read"
  | "message.retracted"
  | "reaction.received"
  | "room.subject"
  | "room.member"
  | "room.invite"
  | "jingle"
  | "jingle.error"
  | "sm.failed"
  | "error";

export interface XmppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: number;
  type: "chat" | "groupchat";
  stanzaId?: string;
  replyTo?: string;
  replaceId?: string;
  omemo?: OmemoEnvelope;
  /** Real sender exposed by a non-anonymous MUC, never the room nickname. */
  realSenderJid?: string;
}

interface SendMessageOptions {
  replyToId?: string;
  replyToJid?: string;
  replaceId?: string;
}

export interface OmemoEnvelopeKey {
  rid: number;
  value: string;
  prekey?: boolean;
  n?: number;
  ek?: string;
  pkid?: number;
}

export interface OmemoEnvelope {
  namespace: string;
  sid: number;
  iv: string;
  keys: OmemoEnvelopeKey[];
  payload: string;
}

export interface OmemoBundle {
  deviceId: number;
  signedPreKeyId: number;
  signedPreKeyPublic: string;
  signedPreKeySignature: string;
  identityKey: string;
  preKeys: Array<{ preKeyId: number; value: string }>;
}

export interface RosterContact {
  jid: string;
  name?: string;
  groups: string[];
  subscription: string;
}

export interface MucDiscoveryItem {
  jid: string;
  name?: string;
}

export interface MucBookmark {
  jid: string;
  name: string;
  nickname: string;
  autojoin: boolean;
}

export interface MucRoomConfig {
  isPublic: boolean;
  membersOnly?: boolean;
  nonAnonymous?: boolean;
  password?: string;
}

export interface MucOmemoMembers {
  roomJid: string;
  jids: string[];
}

type EventHandler = (data: unknown) => void;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function sanitizeXmlText(input: string): string {
  if (!input) return "";
  let output = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    const valid =
      code === 0x9
      || code === 0xa
      || code === 0xd
      || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)
      || (code >= 0x10000 && code <= 0x10ffff);
    if (valid) output += ch;
  }
  return output;
}


const OMEMO_NAMESPACE_LEGACY = "eu.siacs.conversations.axolotl";
const OMEMO_NAMESPACE_MODERN = "urn:xmpp:omemo:2";
const OMEMO_NAMESPACES = [OMEMO_NAMESPACE_MODERN, OMEMO_NAMESPACE_LEGACY] as const;
const PUBSUB_NS = "http://jabber.org/protocol/pubsub";
const BOOKMARKS_NS = "urn:xmpp:bookmarks:1";

export function parseMucBookmarks(stanza: Element): MucBookmark[] {
  const bookmarks: MucBookmark[] = [];
  const items = Array.from(stanza.getElementsByTagName("item"));
  for (const item of items) {
    const conference = Array.from(item.getElementsByTagName("conference"))
      .find((node) => node.namespaceURI === BOOKMARKS_NS || node.getAttribute("xmlns") === BOOKMARKS_NS);
    if (!conference) continue;
    const jid = (item.getAttribute("id") ?? "").trim().toLowerCase();
    if (!jid.includes("@") || jid.includes("/")) continue;
    const name = conference.getAttribute("name")?.trim() || jid.split("@")[0];
    const nickname = Array.from(conference.getElementsByTagName("nick"))
      .find((node) => node.namespaceURI === BOOKMARKS_NS || node.getAttribute("xmlns") === BOOKMARKS_NS)
      ?.textContent?.trim() || "";
    bookmarks.push({ jid, name, nickname, autojoin: /^(?:1|true)$/i.test(conference.getAttribute("autojoin") ?? "") });
  }
  for (const conference of Array.from(stanza.getElementsByTagName("conference"))) {
    if (conference.namespaceURI !== "storage:bookmarks" && conference.getAttribute("xmlns") !== "storage:bookmarks") continue;
    const jid = (conference.getAttribute("jid") ?? "").trim().toLowerCase();
    if (!jid.includes("@") || jid.includes("/") || bookmarks.some((item) => item.jid === jid)) continue;
    bookmarks.push({
      jid,
      name: conference.getAttribute("name")?.trim() || jid.split("@")[0],
      nickname: conference.getElementsByTagName("nick")[0]?.textContent?.trim() || "",
      autojoin: /^(?:1|true)$/i.test(conference.getAttribute("autojoin") ?? ""),
    });
  }
  return bookmarks;
}
function omemoDeviceListNode(namespace: string): string {
  return namespace === OMEMO_NAMESPACE_MODERN
    ? `${namespace}:devices`
    : `${namespace}.devicelist`;
}

function bundleNodeFor(namespace: string, deviceId: number): string {
  return namespace === OMEMO_NAMESPACE_MODERN
    ? `${namespace}:bundles:${deviceId}`
    : `${namespace}.bundles:${deviceId}`;
}

function parseOmemoEnvelope(stanza: Element): OmemoEnvelope | null {
  const all = Array.from(stanza.getElementsByTagName("*"));
  const encrypted = all.find((node) => {
    const local = (node.localName || node.tagName || "").toLowerCase();
    if (local !== "encrypted") return false;
    const ns = node.namespaceURI || node.getAttribute("xmlns") || "";
    return OMEMO_NAMESPACES.includes(ns as (typeof OMEMO_NAMESPACES)[number]);
  }) as Element | undefined;
  if (!encrypted) return null;
  const namespace = (encrypted.namespaceURI || encrypted.getAttribute("xmlns") || OMEMO_NAMESPACE_LEGACY) as string;
  const children = Array.from(encrypted.getElementsByTagName("*"));
  const header = children.find((n) => (n.localName || n.tagName || "").toLowerCase() === "header") as Element | undefined;
  const payload = (children.find((n) => (n.localName || n.tagName || "").toLowerCase() === "payload") as Element | undefined)
    ?.textContent?.trim();
  const iv = header
    ? (Array.from(header.getElementsByTagName("*"))
      .find((n) => (n.localName || n.tagName || "").toLowerCase() === "iv") as Element | undefined)
      ?.textContent?.trim()
    : undefined;
  const sidRaw = header?.getAttribute("sid");
  if (!header || !payload || !iv || !sidRaw) return null;
  const sid = Number.parseInt(sidRaw, 10);
  if (!Number.isFinite(sid)) return null;
  const keys: OmemoEnvelopeKey[] = Array.from(header.querySelectorAll("key"))
    .map((node) => {
      const rid = Number.parseInt(node.getAttribute("rid") ?? "", 10);
      const value = node.textContent?.trim() ?? "";
      if (!Number.isFinite(rid) || !value) return null;
      const nRaw = node.getAttribute("n");
      const n = nRaw == null ? undefined : Number.parseInt(nRaw, 10);
      const pkidRaw = node.getAttribute("pkid");
      const pkid = pkidRaw == null ? undefined : Number.parseInt(pkidRaw, 10);
      return {
        rid,
        value,
        prekey: node.getAttribute("prekey") === "true",
        n: Number.isFinite(n as number) ? n : undefined,
        ek: node.getAttribute("ek") ?? undefined,
        pkid: Number.isFinite(pkid as number) ? pkid : undefined,
      } as OmemoEnvelopeKey;
    })
    .filter((x): x is OmemoEnvelopeKey => Boolean(x));
  if (keys.length === 0) return null;
  return {
    namespace,
    sid,
    iv,
    keys,
    payload,
  };
}

export class XmppClient {
  readonly config: XmppClientConfig;
  private handlers: Map<XmppEvent, EventHandler[]> = new Map();
  private _connection: any = null;
  private _connected = false;
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private _Strophe: any = null;
  private _$msg: any = null;
  private _$iq: any = null;
  private _$pres: any = null;
  private _lastFullJidByBare: Map<string, string> = new Map();
  private _recentMessageFullJidByBare: Map<string, string> = new Map();
  private _availableFullJidsByBare: Map<string, Set<string>> = new Map();
  private _pendingCallProposals = new Map<string, {
    bareJid: string;
    resolve: (fullJid: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(config: XmppClientConfig) {
    this.config = config;
  }

  get connected() { return this._connected; }

  /** Register this XMPP session for XEP-0357 notifications. Re-send after reconnect. */
  setPushEnabled(enabled: boolean, node: string): Promise<void> {
    if (!this._connection || !this._connected) return Promise.reject(new Error("XMPP is not connected"));
    const domain = this.config.jid.split("@")[1]?.split("/")[0];
    if (!domain || !/^[a-z0-9.-]+$/i.test(domain) || !/^[a-zA-Z0-9_-]{1,128}$/.test(node)) {
      return Promise.reject(new Error("Invalid push registration"));
    }
    const iq = this._$iq({ type: "set" })
      .c(enabled ? "enable" : "disable", {
        xmlns: "urn:xmpp:push:0",
        jid: `push.${domain}`,
        node,
      }).tree();
    return new Promise((resolve, reject) => {
      this._connection.sendIQ(iq, () => resolve(), reject, 10000);
    });
  }

  on(event: XmppEvent, handler: EventHandler) {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, [...list, handler]);
    return () => this.off(event, handler);
  }

  off(event: XmppEvent, handler: EventHandler) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== handler));
  }

  private emit(event: XmppEvent, data: unknown) {
    (this.handlers.get(event) ?? []).forEach((h) => h(data));
  }

  async connect(): Promise<void> {
    const { Strophe, $msg, $iq, $pres } = await import("strophe.js");
    this._Strophe = Strophe;
    this._$msg = $msg;
    this._$iq = $iq;
    this._$pres = $pres;

    return new Promise((resolve, reject) => {
      let everConnected = false;
      const conn = new Strophe.Connection(this.config.wsUrl, {
        enableStreamManagement: true,
        streamManagement: { requestResume: true },
      });
      this._connection = conn;

      conn.connect(this.config.jid, this.config.password, (status: number, condition?: string | null) => {
        const ts = new Date().toISOString();
        const accountId = this.config.accountId;
        switch (status) {
          case Strophe.Status.CONNECTED:
            everConnected = true;
            // eslint-disable-next-line no-console
            console.info(`[XMPP ${ts}] CONNECTED account=${accountId}`);
            this._connected = true;
            this.emit("connection.changed", { status: "connected", accountId: this.config.accountId });
            this._setupHandlers();
            this._setupDiscoHandler();      // XEP-0030 service discovery
            this._enableCarbons();          // XEP-0280 multi-device sync
            this._setupCsiHandling();       // XEP-0352 active/inactive
            this._sendPresence();           // includes XEP-0115 caps
            this._requestRoster();
            this._startKeepalive();
            resolve();
            break;
          case Strophe.Status.DISCONNECTED:
            // eslint-disable-next-line no-console
            console.warn(`[XMPP ${ts}] DISCONNECTED account=${accountId} reason=${condition ?? "unknown"}`);
            this._connected = false;
            this._stopKeepalive();
            this.emit("connection.changed", {
              status: "disconnected",
              accountId: this.config.accountId,
              reason: condition ?? "unknown",
            });
            if (!everConnected) reject(new Error("XMPP connection closed before login completed"));
            break;
          case Strophe.Status.AUTHFAIL:
            // eslint-disable-next-line no-console
            console.error(`[XMPP ${ts}] AUTHFAIL account=${accountId}`);
            reject(new Error("Authentication failed. Check your JID and password."));
            break;
          case Strophe.Status.CONNFAIL:
            // eslint-disable-next-line no-console
            console.error(`[XMPP ${ts}] CONNFAIL account=${accountId} condition=${condition ?? "unknown"}`);
            if (this._connected) {
              this._connected = false;
              this._stopKeepalive();
              this.emit("connection.changed", { status: "disconnected", accountId });
            }
            reject(new Error("Connection failed. Check the WebSocket URL."));
            break;
          case Strophe.Status.ERROR:
            // eslint-disable-next-line no-console
            console.warn(`[XMPP ${ts}] ERROR account=${accountId} condition=${condition ?? "unknown"}`);
            this.emit("error", { type: "generic", accountId: this.config.accountId, condition });
            break;
          case Strophe.Status.CONNECTING:
            // eslint-disable-next-line no-console
            console.debug(`[XMPP ${ts}] CONNECTING account=${accountId}`);
            break;
          case Strophe.Status.AUTHENTICATING:
            // eslint-disable-next-line no-console
            console.debug(`[XMPP ${ts}] AUTHENTICATING account=${accountId}`);
            break;
        }
      });
    });
  }

  private _setupHandlers() {
    const conn = this._connection;

    // Incoming messages
    conn.addHandler((stanza: Element) => {
      // MAM-forwarded messages have their own query handler below. Treating
      // nested fallback bodies as live messages would resurrect retractions.
      if (Array.from(stanza.children).some((child) => child.localName === "result" && child.namespaceURI === "urn:xmpp:mam:2")) return true;
      // XEP-0280 Message Carbons unwrapping:
      // <message><sent|received><forwarded><message>...real message...
      // Only trust carbons from our own bare JID.
      const ownBareJid = this.config.jid.split("/")[0].toLowerCase();
      const stanzaFromBare = (stanza.getAttribute("from") ?? "").split("/")[0].toLowerCase();

      let realStanza: Element = stanza;
      let isCarbonSent = false;
      let isCarbonReceived = false;

      const carbonSent = stanza.querySelector('sent[xmlns="urn:xmpp:carbons:2"]');
      const carbonRecv = stanza.querySelector('received[xmlns="urn:xmpp:carbons:2"]');
      if ((carbonSent || carbonRecv) && stanzaFromBare === ownBareJid) {
        const wrapper = carbonSent ?? carbonRecv;
        const forwarded = wrapper?.querySelector('forwarded[xmlns="urn:xmpp:forward:0"]');
        const inner = forwarded?.querySelector("message");
        if (inner) {
          realStanza = inner;
          isCarbonSent = !!carbonSent;
          isCarbonReceived = !!carbonRecv;
        }
      }

      const from = realStanza.getAttribute("from") ?? "";
      const type = realStanza.getAttribute("type") ?? "chat";
      const body = realStanza.querySelector("body")?.textContent ?? "";
      // A live direct message identifies the peer's current resource even
      // when reciprocal roster presence is unavailable across servers.
      if (!isCarbonSent && !isCarbonReceived && type === "chat" && from.includes("/")) {
        const bare = normalizeValidBareJid(from);
        if (bare) this._recentMessageFullJidByBare.set(bare, from);
      }
      // Parse OMEMO from the effective stanza (after carbon unwrapping).
      const omemo = parseOmemoEnvelope(realStanza);
      const id = realStanza.getAttribute("id") ?? crypto.randomUUID();
      const roomBareJid = from.split("/")[0];
      const stanzaId = type === "groupchat"
        ? Array.from(realStanza.children).find((child) => child.localName === "stanza-id"
          && child.namespaceURI === "urn:xmpp:sid:0"
          && child.getAttribute("by") === roomBareJid)?.getAttribute("id") ?? undefined
        : undefined;
      const subject = realStanza.querySelector("subject")?.textContent ?? "";
      if (type === "groupchat" && subject) {
        this.emit("room.subject", { accountId: this.config.accountId, roomJid: from.split("/")[0], subject });
        return true;
      }

      const mucInvite = realStanza.querySelector('x[xmlns="http://jabber.org/protocol/muc#user"] invite');
      if (mucInvite) {
        const roomJid = from.split("/")[0];
        const reason = mucInvite.querySelector("reason")?.textContent?.trim() ?? "";
        if (roomJid) {
          this.emit("room.invite", {
            accountId: this.config.accountId,
            roomJid,
            inviterJid: mucInvite.getAttribute("from") ?? from,
            reason,
          });
        }
        return true;
      }

      const directInvite = realStanza.querySelector('x[xmlns="jabber:x:conference"]');
      if (directInvite) {
        const roomJid = directInvite.getAttribute("jid") ?? "";
        const reason = directInvite.getAttribute("reason") ?? directInvite.textContent?.trim() ?? "";
        if (roomJid) {
          this.emit("room.invite", {
            accountId: this.config.accountId,
            roomJid,
            inviterJid: from,
            reason,
            password: directInvite.getAttribute("password") ?? undefined,
          });
        }
        return true;
      }

      if (realStanza.querySelector("composing")) {
        this.emit("typing.started", { accountId: this.config.accountId, from });
      }
      if (realStanza.querySelector("paused") || realStanza.querySelector("active")) {
        this.emit("typing.stopped", { accountId: this.config.accountId, from });
      }

      const received = realStanza.querySelector("received");
      if (received) {
        this.emit("message.delivered", {
          accountId: this.config.accountId,
          messageId: received.getAttribute("id"),
          from,
        });
        return true;
      }
      const displayed = realStanza.querySelector("displayed");
      if (displayed) {
        this.emit("message.read", {
          accountId: this.config.accountId,
          messageId: displayed.getAttribute("id"),
          from,
        });
        return true;
      }
      // XEP-0444 Message Reactions
      const reactionsEl = realStanza.querySelector('reactions[xmlns="urn:xmpp:reactions:0"]');
      if (reactionsEl) {
        const msgId = reactionsEl.getAttribute("id");
        const emojis = Array.from(reactionsEl.querySelectorAll("reaction"))
          .map((r) => r.textContent?.trim() ?? "")
          .filter(Boolean);
        if (msgId) {
          this.emit("reaction.received", {
            accountId: this.config.accountId,
            from,
            messageId: msgId,
            emojis,
          });
        }
        return true;
      }

      const directChildren = Array.from(realStanza.children);
      const applyTo = directChildren.find((child) => child.localName === "apply-to" && child.namespaceURI === "urn:xmpp:fasten:0");
      const retracted = directChildren.find((child) =>
        child.localName === "retract" && child.namespaceURI === "urn:xmpp:message-retract:1"
      ) ?? Array.from(applyTo?.children ?? []).find((child) => child.localName === "retract" && child.namespaceURI === "urn:xmpp:message-retract:1");
      if (retracted) {
        this.emit("message.retracted", {
          accountId: this.config.accountId,
          messageId: retracted.getAttribute("id") ?? applyTo?.getAttribute("id"),
          from,
          type,
          to: realStanza.getAttribute("to") ?? "",
          realSenderJid: normalizeValidBareJid(realStanza.querySelector('x[xmlns="http://jabber.org/protocol/muc#user"] item[jid]')?.getAttribute("jid") ?? "") ?? undefined,
        });
        return true;
      }

      if (body || omemo) {
        const replyNode = realStanza.querySelector('reply[xmlns="urn:xmpp:reply:0"]');
        const replaceNode = realStanza.querySelector('replace[xmlns="urn:xmpp:message-correct:0"]');
        const msg: XmppMessage = {
          id,
          from,
          to: realStanza.getAttribute("to") ?? this.config.jid,
          body: body || "[OMEMO message]",
          timestamp: Date.now(),
          type: type as "chat" | "groupchat",
          stanzaId,
          replyTo: replyNode?.getAttribute("id") ?? undefined,
          replaceId: replaceNode?.getAttribute("id") ?? undefined,
          omemo: omemo ?? undefined,
          realSenderJid: type === "groupchat"
            ? normalizeValidBareJid(realStanza.querySelector('x[xmlns="http://jabber.org/protocol/muc#user"] item[jid]')?.getAttribute("jid") ?? "") ?? undefined
            : undefined,
        };
        this.emit("message.received", {
          accountId: this.config.accountId,
          message: msg,
          isCarbonSent,
          isCarbonReceived,
        });
      }
      return true;
    }, null, "message");

    // Roster result
    conn.addHandler((stanza: Element) => {
      const contacts = this._parseRosterStanza(stanza);
      this.emit("roster.updated", { accountId: this.config.accountId, contacts });
      return true;
    }, "jabber:iq:roster", "iq", "result");

    // Roster push
    conn.addHandler((stanza: Element) => {
      const contacts = this._parseRosterStanza(stanza);
      this.emit("roster.updated", { accountId: this.config.accountId, contacts });
      return true;
    }, "jabber:iq:roster", "iq", "set");

    // Presence
    conn.addHandler((stanza: Element) => {
      const from = stanza.getAttribute("from") ?? "";
      const validFromBare = normalizeValidBareJid(from);
      const type = stanza.getAttribute("type") ?? "available";
      const fromParts = from.split("/");
      const roomJid = fromParts[0] ?? "";
      const nickname = fromParts[1] ?? "";
      const mucUser = stanza.querySelector('x[xmlns="http://jabber.org/protocol/muc#user"]');
      if (mucUser && roomJid && nickname) {
        const item = mucUser.querySelector("item");

        // Detect kick / ban / room destroy via status codes (XEP-0045 §15.6)
        //   110: this is your own presence
        //   301: banned
        //   307: kicked
        //   321: removed because affiliation changed (no longer member)
        //   322: removed because room is now members-only
        //   332: removed because of system shutdown
        //   333: removed because of error
        const statusCodes = Array.from(mucUser.querySelectorAll("status"))
          .map((s) => s.getAttribute("code"))
          .filter((c): c is string => c !== null);
        const isOwn = statusCodes.includes("110");
        if (type === "unavailable" && isOwn) {
          let removalReason: string | null = null;
          if (statusCodes.includes("307")) removalReason = "kicked";
          else if (statusCodes.includes("301")) removalReason = "banned";
          else if (statusCodes.includes("321")) removalReason = "affiliation-removed";
          else if (statusCodes.includes("322")) removalReason = "members-only";
          else if (statusCodes.includes("332")) removalReason = "system-shutdown";
          else if (statusCodes.includes("333")) removalReason = "error";
          if (removalReason) {
            const actor = mucUser.querySelector("item > actor")?.getAttribute("nick")
              ?? mucUser.querySelector("item > actor")?.getAttribute("jid")
              ?? null;
            const reasonText = mucUser.querySelector("item > reason")?.textContent ?? null;
            // eslint-disable-next-line no-console
            console.warn(`[XMPP MUC] removed-from-room room=${roomJid} reason=${removalReason}`);
            this.emit("room.removed", {
              accountId: this.config.accountId,
              roomJid,
              reason: removalReason,
              actor,
              reasonText,
            });
            return true;
          }
        }
        // Detect room destroyed: <x><destroy jid="..."><reason/></destroy></x>
        const destroy = mucUser.querySelector("destroy");
        if (destroy) {
          const altJid = destroy.getAttribute("jid") ?? null;
          const reasonText = destroy.querySelector("reason")?.textContent ?? null;
          // eslint-disable-next-line no-console
          console.warn(`[XMPP MUC] room-destroyed room=${roomJid}`);
          this.emit("room.destroyed", {
            accountId: this.config.accountId,
            roomJid,
            altJid,
            reasonText,
          });
          return true;
        }

        this.emit("room.member", {
          accountId: this.config.accountId,
          roomJid,
          nickname,
          jid: item?.getAttribute("jid") ?? `${nickname}@${roomJid}`,
          role: (item?.getAttribute("role") ?? "participant") as "moderator" | "participant" | "visitor",
          affiliation: (item?.getAttribute("affiliation") ?? "none") as "owner" | "admin" | "member" | "none",
          presence: type === "unavailable" ? "unavailable" : "available",
        });
        return true;
      }
      if (type === "subscribe") {
        if (validFromBare) {
          this.emit("subscription.request", { accountId: this.config.accountId, jid: validFromBare });
        }
        return true;
      }
      if (type === "subscribed") {
        if (validFromBare) {
          this.emit("subscription.approved", { accountId: this.config.accountId, jid: validFromBare });
        }
        return true;
      }
      if (type === "unsubscribed") {
        if (validFromBare) {
          this.emit("subscription.denied", { accountId: this.config.accountId, jid: validFromBare });
        }
        return true;
      }
      if (!validFromBare || (type !== "available" && type !== "unavailable")) {
        return true;
      }
      if (type === "available" && from.includes("/")) {
        const available = this._availableFullJidsByBare.get(validFromBare) ?? new Set<string>();
        available.delete(from);
        available.add(from);
        this._availableFullJidsByBare.set(validFromBare, available);
        this._lastFullJidByBare.set(validFromBare, from);
      } else if (type === "unavailable") {
        const available = this._availableFullJidsByBare.get(validFromBare);
        available?.delete(from);
        if (available?.size === 0) this._availableFullJidsByBare.delete(validFromBare);
        if (this._lastFullJidByBare.get(validFromBare) === from) {
          const replacement = available?.size ? [...available][available.size - 1] : undefined;
          if (replacement) this._lastFullJidByBare.set(validFromBare, replacement);
          else this._lastFullJidByBare.delete(validFromBare);
        }
        if (this._recentMessageFullJidByBare.get(validFromBare) === from) {
          this._recentMessageFullJidByBare.delete(validFromBare);
        }
      }
      const show = stanza.querySelector("show")?.textContent
        ?? (type === "unavailable" ? "unavailable" : "available");
      const status = stanza.querySelector("status")?.textContent ?? undefined;
      this.emit("presence.updated", { accountId: this.config.accountId, jid: validFromBare, show, status });
      return true;
    }, null, "presence");

    // Jingle (XEP-0166) IQ handler - audio/video calls
    conn.addHandler((stanza: Element) => {
      const from = stanza.getAttribute("from") ?? "";
      const response = Array.from(stanza.children).find((child) =>
        child.namespaceURI === "urn:xmpp:jingle-message:0"
        && ["proceed", "reject"].includes(child.localName)
      );
      const id = response?.getAttribute("id");
      const pending = id ? this._pendingCallProposals.get(id) : undefined;
      if (pending && normalizeBareJid(from) === pending.bareJid) {
        clearTimeout(pending.timer);
        this._pendingCallProposals.delete(id!);
        if (response?.localName === "proceed" && from.includes("/")) {
          this._lastFullJidByBare.set(pending.bareJid, from);
          pending.resolve(from);
        } else {
          pending.reject(new Error("Call declined by the contact"));
        }
      }
      return true;
    }, "urn:xmpp:jingle-message:0", "message");

    conn.addHandler((stanza: Element) => {
      const jingle = Array.from(stanza.getElementsByTagName("jingle"))
        .find((el) =>
          el.namespaceURI === "urn:xmpp:jingle:1"
          || el.getAttribute("xmlns") === "urn:xmpp:jingle:1"
        );
      if (!jingle) return true;

      const fromJid = stanza.getAttribute("from") ?? "";
      const sid = jingle.getAttribute("sid") ?? "";
      const action = jingle.getAttribute("action") ?? "";
      const iqId = stanza.getAttribute("id") ?? "";

      // Acknowledge the IQ immediately
      const ack = this._$iq({ type: "result", to: fromJid, id: iqId });
      conn.send(ack);

      // Emit to bridge for routing to callManager
      this.emit("jingle", {
        accountId: this.config.accountId,
        from: fromJid,
        sid,
        action,
        jingleEl: jingle,
      });
      return true;
    }, "urn:xmpp:jingle:1", "iq", "set");

  }

  private _parseRosterStanza(stanza: Element): RosterContact[] {
    const contacts: RosterContact[] = [];
    stanza.querySelectorAll("item").forEach((item) => {
      contacts.push({
        jid: item.getAttribute("jid") ?? "",
        name: item.getAttribute("name") ?? undefined,
        groups: Array.from(item.querySelectorAll("group")).map((g) => g.textContent ?? ""),
        subscription: item.getAttribute("subscription") ?? "none",
      });
    });
    return contacts;
  }

  private _capsHash: string | null = null;

  private async _ensureCapsHash() {
    if (this._capsHash) return this._capsHash;
    try {
      this._capsHash = await this._computeCapsHash();
    } catch {
      this._capsHash = null;
    }
    return this._capsHash;
  }

  private async _sendPresence(show?: string, status?: string) {
    if (!this._connection) return;
    const hash = await this._ensureCapsHash();
    let pres: any;
    if (!show || show === "available") {
      pres = this._$pres();
    } else if (show === "unavailable") {
      pres = this._$pres({ type: "unavailable" });
    } else {
      pres = this._$pres().c("show").t(show).up();
      if (status) pres.c("status").t(status).up();
    }
    // XEP-0115 Entity Capabilities
    if (hash && (!show || show !== "unavailable")) {
      pres.c("c", {
        xmlns: "http://jabber.org/protocol/caps",
        hash: "sha-1",
        node: "https://lyaotalk.dev/caps",
        ver: hash,
      }).up();
    }
    this._connection.send(pres);
  }

  private _requestRoster() {
    if (!this._connection) return;
    this._connection.send(
      this._$iq({ type: "get" }).c("query", { xmlns: "jabber:iq:roster" })
    );
  }

  sendMessage(toJid: string, body: string, type: "chat" | "groupchat" = "chat", options?: SendMessageOptions): string {
    if (!this._connection || !this._connected) throw new Error("Not connected");
    const safeBody = sanitizeXmlText(body);
    if (!safeBody.trim()) throw new Error("Message contains unsupported characters");
    const id = crypto.randomUUID();
    const stanza = this._$msg({ to: toJid, type, id })
      .c("body").t(safeBody)
      .up()
      .c("request", { xmlns: "urn:xmpp:receipts" })
      .up();
    if (options?.replyToId) {
      stanza.c("reply", {
        xmlns: "urn:xmpp:reply:0",
        id: options.replyToId,
        to: options.replyToJid ?? toJid,
      });
      stanza.up();
    }
    if (options?.replaceId) {
      stanza.c("replace", {
        xmlns: "urn:xmpp:message-correct:0",
        id: options.replaceId,
      });
    }
    this._connection.send(stanza);
    const msg: XmppMessage = {
      id,
      from: this.config.jid,
      to: toJid,
      body: safeBody,
      timestamp: Date.now(),
      type,
      replyTo: options?.replyToId,
      replaceId: options?.replaceId,
    };
    this.emit("message.sent", { accountId: this.config.accountId, message: msg });
    return id;
  }

  sendOmemoMessage(
    toJid: string,
    envelope: OmemoEnvelope,
    type: "chat" | "groupchat" = "chat",
    options?: SendMessageOptions,
    plaintextForLocalEcho?: string
  ): string {
    if (!this._connection || !this._connected) throw new Error("Not connected");
    const id = crypto.randomUUID();
    // Body fallback per XEP-0384 §4.5 — for clients that don't speak OMEMO at all.
    // Recipients that DO support OMEMO will ignore this body in favor of <encrypted>.
    const fallbackBody = "I sent you an OMEMO encrypted message but your client doesn't seem to support that. Find more information on https://conversations.im/omemo";
    const stanza = this._$msg({ to: toJid, type, id })
      .c("body").t(fallbackBody)
      .up()
      // XEP-0380 Explicit Message Encryption — tells recipients this is OMEMO
      // so they show a proper E2EE indicator instead of "unknown encryption".
      .c("encryption", {
        xmlns: "urn:xmpp:eme:0",
        namespace: envelope.namespace,
        name: "OMEMO",
      })
      .up()
      // XEP-0334 hints — tell server NOT to copy this stanza in plain to other
      // resources (no-copy) and DO archive it (store, since body is opaque).
      .c("store", { xmlns: "urn:xmpp:hints" }).up()
      .c("no-copy", { xmlns: "urn:xmpp:hints" }).up()
      .c("request", { xmlns: "urn:xmpp:receipts" })
      .up();
    if (options?.replyToId) {
      stanza.c("reply", {
        xmlns: "urn:xmpp:reply:0",
        id: options.replyToId,
        to: options.replyToJid ?? toJid,
      });
      stanza.up();
    }
    if (options?.replaceId) {
      stanza.c("replace", {
        xmlns: "urn:xmpp:message-correct:0",
        id: options.replaceId,
      });
      stanza.up();
    }

    const encrypted = stanza.c("encrypted", { xmlns: envelope.namespace })
      .c("header", { sid: String(envelope.sid) });
    envelope.keys.forEach((key) => {
      encrypted.c("key", {
        rid: String(key.rid),
        ...(key.prekey ? { prekey: "true" } : {}),
        ...(typeof key.n === "number" ? { n: String(key.n) } : {}),
        ...(typeof key.pkid === "number" ? { pkid: String(key.pkid) } : {}),
        ...(key.ek ? { ek: key.ek } : {}),
      }).t(key.value).up();
    });
    encrypted.c("iv").t(envelope.iv).up().up().c("payload").t(envelope.payload).up().up();

    this._connection.send(stanza);
    const msg: XmppMessage = {
      id,
      from: this.config.jid,
      to: toJid,
      // Local echo carries plaintext when available so other parts of the app
      // (carbons, MAM dedup) can match by content. The wire body is the
      // OMEMO fallback hint sent above.
      body: plaintextForLocalEcho ?? fallbackBody,
      timestamp: Date.now(),
      type,
      replyTo: options?.replyToId,
      replaceId: options?.replaceId,
      omemo: envelope,
    };
    this.emit("message.sent", { accountId: this.config.accountId, message: msg });
    return id;
  }

  sendTyping(toJid: string, isTyping: boolean) {
    if (!this._connection || !this._connected) return;
    const state = isTyping ? "composing" : "paused";
    this._connection.send(
      this._$msg({ to: toJid, type: "chat" })
        .c(state, { xmlns: "http://jabber.org/protocol/chatstates" })
    );
  }

  sendReceipt(toJid: string, messageId: string, kind: "received" | "displayed" = "received") {
    if (!this._connection || !this._connected || !messageId) return;
    this._connection.send(
      this._$msg({ to: toJid, type: "chat" })
        .c(kind, { xmlns: "urn:xmpp:receipts", id: messageId })
    );
  }

  retractMessage(toJid: string, messageId: string, type: "chat" | "groupchat" = "chat") {
    if (!this._connection || !this._connected) throw new Error("Not connected");
    if (!messageId) throw new Error("Message ID is unavailable");
    const stanza = this._$msg({ to: toJid, type, id: crypto.randomUUID() })
      .c("retract", { xmlns: "urn:xmpp:message-retract:1", id: messageId })
      .up()
      .c("fallback", { xmlns: "urn:xmpp:fallback:0", for: "urn:xmpp:message-retract:1" })
      .up()
      .c("body").t("/me retracted a previous message, but it's unsupported by your client.")
      .up()
      .c("store", { xmlns: "urn:xmpp:hints" }).up();
    this._connection.send(stanza);
  }

  setPresence(show: string, status?: string) {
    this._sendPresence(show, status);
  }

  addContact(jid: string, name?: string) {
    if (!this._connection) return;
    this._connection.send(this._$pres({ to: jid, type: "subscribe" }));
    this._connection.send(
      this._$iq({ type: "set" })
        .c("query", { xmlns: "jabber:iq:roster" })
        .c("item", { jid, ...(name ? { name } : {}) })
    );
  }

  approveSubscription(jid: string) {
    if (!this._connection) return;
    this._connection.send(this._$pres({ to: jid, type: "subscribed" }));
  }

  denySubscription(jid: string) {
    if (!this._connection) return;
    this._connection.send(this._$pres({ to: jid, type: "unsubscribed" }));
  }

  blockJid(jid: string) {
    if (!this._connection) return;
    this._connection.send(
      this._$iq({ type: "set" })
        .c("block", { xmlns: "urn:xmpp:blocking" })
        .c("item", { jid })
    );
  }

  unblockJid(jid: string) {
    if (!this._connection) return;
    this._connection.send(
      this._$iq({ type: "set" })
        .c("unblock", { xmlns: "urn:xmpp:blocking" })
        .c("item", { jid })
    );
  }

  removeContact(jid: string) {
    if (!this._connection) return;
    this._connection.send(this._$pres({ to: jid, type: "unsubscribe" }));
    this._connection.send(
      this._$iq({ type: "set" })
        .c("query", { xmlns: "jabber:iq:roster" })
        .c("item", { jid, subscription: "remove" })
    );
  }

  /**
   * Join a MUC room (XEP-0045).
   *
   * Returns a Promise that resolves when the server sends our self-presence
   * (`<status code="110"/>`) confirming we're in the room. Rejects if the
   * server returns `<presence type="error">` (room doesn't exist, not on
   * member list, banned, password incorrect, etc).
   *
   * `room.joined` event fires only AFTER server confirmation. The frontend
   * should never set "joined" state from a synchronous return value of
   * this method — wait for the promise to resolve.
   */
  fetchMucBookmarks(): Promise<MucBookmark[]> {
    if (!this._connection || !this._connected) return Promise.reject(new Error("Not connected"));
    const query = (stanza: Element) => new Promise<MucBookmark[]>((resolve) => {
      this._connection.sendIQ(stanza, (result: Element) => resolve(parseMucBookmarks(result)), () => resolve([]), 10000);
    });
    const modern = this._$iq({ type: "get" }).c("pubsub", { xmlns: PUBSUB_NS }).c("items", { node: BOOKMARKS_NS });
    const legacyPep = this._$iq({ type: "get" }).c("pubsub", { xmlns: PUBSUB_NS }).c("items", { node: "storage:bookmarks" });
    const legacyPrivate = this._$iq({ type: "get" }).c("query", { xmlns: "jabber:iq:private" }).c("storage", { xmlns: "storage:bookmarks" });
    return Promise.all([query(modern.tree()), query(legacyPep.tree()), query(legacyPrivate.tree())]).then((sources) => {
      const byJid = new Map<string, MucBookmark>();
      for (const source of sources) for (const bookmark of source) if (!byJid.has(bookmark.jid)) byJid.set(bookmark.jid, bookmark);
      return [...byJid.values()];
    });
  }

  publishMucBookmark(bookmark: MucBookmark): Promise<void> {
    if (!this._connection || !this._connected) return Promise.reject(new Error("Not connected"));
    const iq = this._$iq({ type: "set" })
      .c("pubsub", { xmlns: PUBSUB_NS })
      .c("publish", { node: BOOKMARKS_NS })
      .c("item", { id: bookmark.jid })
      .c("conference", { xmlns: BOOKMARKS_NS, name: bookmark.name, autojoin: bookmark.autojoin ? "true" : "false" })
      .c("nick").t(bookmark.nickname).up().up().up().up()
      .c("publish-options")
      .c("x", { xmlns: "jabber:x:data", type: "submit" })
      .c("field", { var: "FORM_TYPE", type: "hidden" }).c("value").t("http://jabber.org/protocol/pubsub#publish-options").up().up()
      .c("field", { var: "pubsub#persist_items" }).c("value").t("true").up().up()
      .c("field", { var: "pubsub#max_items" }).c("value").t("256").up().up()
      .c("field", { var: "pubsub#send_last_published_item" }).c("value").t("never").up().up()
      .c("field", { var: "pubsub#access_model" }).c("value").t("whitelist");
    return new Promise((resolve, reject) => {
      this._connection.sendIQ(iq.tree(), () => resolve(), reject, 10000);
    });
  }

  async retractMucBookmark(jid: string): Promise<void> {
    if (!this._connection || !this._connected) throw new Error("Not connected");
    const roomJid = jid.trim().toLowerCase();
    const sendIq = (stanza: Element) => new Promise<Element>((resolve, reject) => {
      this._connection!.sendIQ(stanza, resolve, reject, 10000);
    });
    const read = (stanza: Element) => sendIq(stanza).catch(() => null);
    const modern = await read(this._$iq({ type: "get" })
      .c("pubsub", { xmlns: PUBSUB_NS }).c("items", { node: BOOKMARKS_NS }).tree());
    if (modern && parseMucBookmarks(modern).some((bookmark) => bookmark.jid === roomJid)) {
      await sendIq(this._$iq({ type: "set" })
        .c("pubsub", { xmlns: PUBSUB_NS })
        .c("retract", { node: BOOKMARKS_NS, notify: "true" })
        .c("item", { id: roomJid }).tree());
    }

    // Conversations and other clients may still use XEP-0048 bookmarks.
    // Removing only the XEP-0402 item lets those legacy bookmarks rejoin the room.
    const removeFromStorage = (result: Element | null): { storage: Element; itemId: string } | null => {
      const source = result && Array.from(result.getElementsByTagName("storage"))
        .find((node) => node.namespaceURI === "storage:bookmarks" || node.getAttribute("xmlns") === "storage:bookmarks");
      if (!source) return null;
      const storage = source.cloneNode(true) as Element;
      const matching = Array.from(storage.getElementsByTagName("conference"))
        .filter((node) => node.getAttribute("jid")?.trim().toLowerCase() === roomJid);
      if (!matching.length) return null;
      matching.forEach((node) => node.parentNode?.removeChild(node));
      return { storage, itemId: source.parentElement?.getAttribute("id") || "current" };
    };

    const legacyPep = removeFromStorage(await read(this._$iq({ type: "get" })
      .c("pubsub", { xmlns: PUBSUB_NS }).c("items", { node: "storage:bookmarks" }).tree()));
    if (legacyPep) {
      const publish = this._$iq({ type: "set" })
        .c("pubsub", { xmlns: PUBSUB_NS })
        .c("publish", { node: "storage:bookmarks" })
        .c("item", { id: legacyPep.itemId });
      publish.cnode(legacyPep.storage);
      await sendIq(publish.tree());
    }

    const legacyPrivate = removeFromStorage(await read(this._$iq({ type: "get" })
      .c("query", { xmlns: "jabber:iq:private" }).c("storage", { xmlns: "storage:bookmarks" }).tree()));
    if (legacyPrivate) {
      const update = this._$iq({ type: "set" }).c("query", { xmlns: "jabber:iq:private" });
      update.cnode(legacyPrivate.storage);
      await sendIq(update.tree());
    }

    if ((await this.fetchMucBookmarks()).some((bookmark) => bookmark.jid === roomJid)) {
      throw new Error("Room bookmark could not be removed");
    }
  }

  joinRoom(roomJid: string, nickname: string, password?: string): Promise<void> {
    if (!this._connection || !this._connected) {
      return Promise.reject(new Error("Not connected"));
    }
    const fullJid = `${roomJid}/${nickname}`;
    const pres = this._$pres({ to: fullJid })
      .c("x", { xmlns: "http://jabber.org/protocol/muc" });
    if (password) pres.c("password").t(password);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const handler = (stanza: Element) => {
        if (settled) return false; // remove
        const from = stanza.getAttribute("from") ?? "";
        if (from !== fullJid) return true; // keep, not ours
        const type = stanza.getAttribute("type") ?? "available";
        if (type === "error") {
          const errEl = stanza.querySelector("error");
          const code = errEl?.getAttribute("code") ?? "";
          const condition = errEl?.firstElementChild?.tagName ?? "unknown";
          settled = true;
          // eslint-disable-next-line no-console
          console.warn(`[XMPP MUC] join-failed room=${roomJid} code=${code} condition=${condition}`);
          this.emit("room.join.failed", {
            accountId: this.config.accountId,
            roomJid,
            code,
            condition,
          });
          reject(new Error(`MUC join failed: ${condition}${code ? ` (${code})` : ""}`));
          return false;
        }
        // Look for self-presence marker (status code 110). Browser XML
        // namespace handling is inconsistent for CSS selectors, so inspect
        // localName/namespaceURI instead of `querySelectorAll('x[xmlns=...]')`.
        const mucUserEls = Array.from(stanza.getElementsByTagName("x"))
          .filter((el) =>
            el.namespaceURI === "http://jabber.org/protocol/muc#user"
            || el.getAttribute("xmlns") === "http://jabber.org/protocol/muc#user"
          );
        const statusCodes = mucUserEls.flatMap((x) =>
          Array.from(x.getElementsByTagName("status"))
            .map((s) => s.getAttribute("code"))
            .filter((c): c is string => c !== null)
        );
        if (statusCodes.includes("110") && type !== "unavailable") {
          settled = true;
          this.emit("room.joined", {
            accountId: this.config.accountId,
            roomJid,
            nickname,
          });
          resolve();
          return false;
        }
        return true; // keep listening (other participants' presence)
      };
      // Strophe's addHandler returns a handler ref; remove on settle
      const ref = this._connection.addHandler(handler, null, "presence");
      this._connection.send(pres);

      // Safety timeout: if no response in 20s, reject
      setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this._connection.deleteHandler(ref); } catch {}
        // eslint-disable-next-line no-console
        console.warn(`[XMPP MUC] join-timeout room=${roomJid}`);
        this.emit("room.join.failed", {
          accountId: this.config.accountId,
          roomJid,
          code: "timeout",
          condition: "no-response",
        });
        reject(new Error("MUC join timeout"));
      }, 20000);
    });
  }

  leaveRoom(roomJid: string, nickname: string): void {
    if (!this._connection) return;
    this._connection.send(
      this._$pres({ to: `${roomJid}/${nickname}`, type: "unavailable" })
    );
    this.emit("room.left", { accountId: this.config.accountId, roomJid });
  }

  inviteToRoom(roomJid: string, inviteeJid: string, reason?: string) {
    if (!this._connection || !this._connected) throw new Error("Not connected");
    const cleanInvitee = inviteeJid.trim();
    if (!cleanInvitee) throw new Error("Invitee JID is required");
    const cleanReason = reason?.trim() ? sanitizeXmlText(reason.trim()) : "";
    const msg = this._$msg({ to: roomJid, type: "normal" })
      .c("x", { xmlns: "http://jabber.org/protocol/muc#user" })
      .c("invite", { to: cleanInvitee });
    if (cleanReason) msg.c("reason").t(cleanReason);
    this._connection.send(msg);
    this._connection.send(
      this._$msg({ to: cleanInvitee, type: "normal" })
        .c("x", {
          xmlns: "jabber:x:conference",
          jid: roomJid,
          ...(cleanReason ? { reason: cleanReason } : {}),
        })
    );
  }

  discoverRooms(serviceJid: string): Promise<MucDiscoveryItem[]> {
    if (!this._connection || !this._connected) return Promise.reject(new Error("Not connected"));
    const service = serviceJid.trim();
    if (!service) return Promise.reject(new Error("Conference service is required"));
    const iq = this._$iq({ type: "get", to: service })
      .c("query", { xmlns: "http://jabber.org/protocol/disco#items" });
    return new Promise((resolve, reject) => {
      this._connection.sendIQ(
        iq.tree(),
        (result: Element) => {
          const rooms = Array.from(result.querySelectorAll("item"))
            .map((item) => ({
              jid: item.getAttribute("jid")?.trim() ?? "",
              name: item.getAttribute("name")?.trim() || undefined,
            }))
            .filter((room) => room.jid.includes("@"));
          resolve(rooms);
        },
        () => reject(new Error("Room discovery failed"))
      );
    });
  }

  configureRoom(roomJid: string, config: MucRoomConfig): Promise<void> {
    if (!this._connection || !this._connected) return Promise.reject(new Error("Not connected"));
    const iq = this._$iq({ type: "set", to: roomJid })
      .c("query", { xmlns: "http://jabber.org/protocol/muc#owner" })
      .c("x", { xmlns: "jabber:x:data", type: "submit" })
      .c("field", { var: "FORM_TYPE", type: "hidden" })
      .c("value").t("http://jabber.org/protocol/muc#roomconfig").up().up()
      .c("field", { var: "muc#roomconfig_publicroom" })
      .c("value").t(config.isPublic ? "1" : "0").up().up()
      .c("field", { var: "muc#roomconfig_membersonly" })
      .c("value").t(config.membersOnly ? "1" : "0").up().up();

    if (config.nonAnonymous !== undefined) {
      iq.c("field", { var: "muc#roomconfig_whois" })
        .c("value").t(config.nonAnonymous ? "anyone" : "moderators").up().up();
    }

    if (config.password?.trim()) {
      iq.c("field", { var: "muc#roomconfig_passwordprotectedroom" })
        .c("value").t("1").up().up()
        .c("field", { var: "muc#roomconfig_roomsecret" })
        .c("value").t(config.password.trim()).up().up();
    } else {
      iq.c("field", { var: "muc#roomconfig_passwordprotectedroom" })
        .c("value").t("0").up().up();
    }

    return new Promise((resolve, reject) => {
      this._connection.sendIQ(iq.tree(), () => resolve(), () => reject(new Error("Room config failed")));
    });
  }

  /** Query all room affiliations, including offline members, before OMEMO send. */
  async fetchMucOmemoMembers(roomJid: string): Promise<MucOmemoMembers> {
    if (!this._connection || !this._connected) throw new Error("Not connected");
    const room = normalizeValidBareJid(roomJid);
    if (!room) throw new Error("Invalid group address");
    const query = (stanza: Element): Promise<Element> => new Promise((resolve, reject) => {
      this._connection!.sendIQ(stanza, resolve, () => reject(new Error("Cannot inspect group membership")), 10000);
    });
    const info = await query(this._$iq({ type: "get", to: room })
      .c("query", { xmlns: "http://jabber.org/protocol/disco#info" }).tree());
    const features = new Set(Array.from(info.getElementsByTagName("feature"))
      .map((feature) => feature.getAttribute("var") ?? ""));
    if (!features.has("muc_nonanonymous") || !features.has("muc_membersonly")) {
      throw new Error("Group OMEMO requires a non-anonymous, members-only room");
    }
    const jids = new Set<string>();
    for (const affiliation of ["member", "admin", "owner"]) {
      const result = await query(this._$iq({ type: "get", to: room })
        .c("query", { xmlns: "http://jabber.org/protocol/muc#admin" })
        .c("item", { affiliation }).tree());
      for (const item of Array.from(result.getElementsByTagName("item"))) {
        const jid = normalizeValidBareJid(item.getAttribute("jid") ?? "");
        if (!jid) throw new Error("Group member has no visible account address");
        jids.add(jid);
      }
    }
    if (jids.size === 0) throw new Error("Cannot verify group members");
    return { roomJid: room, jids: [...jids] };
  }

  fetchVCardAvatar(jid: string): Promise<string | null> {
    if (!this._connection) return Promise.resolve(null);
    return new Promise((resolve) => {
      const iq = this._$iq({ type: "get", to: jid }).c("vCard", { xmlns: "vcard-temp" });
      this._connection.sendIQ(
        iq.tree(),
        (result: Element) => {
          const photo = result.querySelector("vCard PHOTO");
          const b64 = photo?.querySelector("BINVAL")?.textContent?.trim();
          const mime = photo?.querySelector("TYPE")?.textContent?.trim() || "image/jpeg";
          if (!b64) {
            resolve(null);
            return;
          }
          resolve(`data:${mime};base64,${b64}`);
        },
        () => resolve(null)
      );
    });
  }

  publishOmemoDeviceList(deviceIds: number[]) {
    if (!this._connection) return Promise.resolve();
    const uniqueIds = Array.from(new Set(deviceIds.filter((id) => Number.isFinite(id) && id > 0)));
    const publishToNamespace = (namespace: string) => {
      const node = omemoDeviceListNode(namespace);
      const publish = () => new Promise<void>((resolve, reject) => {
        const iq = this._$iq({ type: "set" })
          .c("pubsub", { xmlns: PUBSUB_NS })
          .c("publish", { node })
          .c("item", { id: "current" })
          .c("list", { xmlns: namespace });
        uniqueIds.forEach((id) => {
          iq.c("device", { id: String(id) }).up();
        });
        iq.up().up().up()
          .c("publish-options")
          .c("x", { xmlns: "jabber:x:data", type: "submit" })
          .c("field", { var: "FORM_TYPE", type: "hidden" }).c("value").t("http://jabber.org/protocol/pubsub#publish-options").up().up()
          .c("field", { var: "pubsub#access_model" }).c("value").t("open");
        this._connection.sendIQ(iq.tree(), () => resolve(), () => reject(new Error("OMEMO devicelist publish failed")));
      });
      // Existing PEP nodes created without publish-options are presence-only.
      // Prosody rejects a different publish option until the owner reconfigures
      // the node. Retry once after opening that public-key node.
      return publish().catch(async () => {
        await this._configureOmemoNodeOpen(node);
        await publish();
      });
    };
    return Promise.allSettled(OMEMO_NAMESPACES.map((ns) => publishToNamespace(ns))).then((results) => {
      if (results.every((r) => r.status === "rejected")) {
        throw new Error("OMEMO devicelist publish failed");
      }
    });
  }

  fetchOmemoDeviceList(jid: string): Promise<number[]> {
    if (!this._connection) return Promise.resolve([]);
    const fetchFromNamespace = (namespace: string) =>
      new Promise<number[]>((resolve) => {
        const iq = this._$iq({ type: "get", to: jid })
          .c("pubsub", { xmlns: PUBSUB_NS })
          .c("items", { node: omemoDeviceListNode(namespace) });
        this._connection.sendIQ(
          iq.tree(),
          (result: Element) => {
            const list = result.querySelector(`list[xmlns="${namespace}"]`);
            if (!list) {
              resolve([]);
              return;
            }
            const ids = Array.from(list.querySelectorAll("device"))
              .map((node) => Number.parseInt(node.getAttribute("id") ?? "", 10))
              .filter((id) => Number.isFinite(id) && id > 0);
            resolve(Array.from(new Set(ids)));
          },
          () => resolve([])
        );
      });
    return Promise.all(OMEMO_NAMESPACES.map((ns) => fetchFromNamespace(ns))).then((groups) =>
      Array.from(new Set(groups.flat()))
    );
  }

  publishOmemoBundle(bundle: OmemoBundle) {
    if (!this._connection) return Promise.resolve();
    const publishToNamespace = (namespace: string) => {
      const node = bundleNodeFor(namespace, bundle.deviceId);
      const publish = () => new Promise<void>((resolve, reject) => {
        const iq = this._$iq({ type: "set" })
          .c("pubsub", { xmlns: PUBSUB_NS })
          .c("publish", { node })
          .c("item", { id: "current" })
          .c("bundle", { xmlns: namespace })
          .c("signedPreKeyPublic", { signedPreKeyId: String(bundle.signedPreKeyId) }).t(bundle.signedPreKeyPublic).up()
          .c("signedPreKeySignature").t(bundle.signedPreKeySignature).up()
          .c("identityKey").t(bundle.identityKey).up()
          .c("prekeys");
        bundle.preKeys.forEach((key) => {
          iq.c("preKeyPublic", { preKeyId: String(key.preKeyId) }).t(key.value).up();
        });
        iq.up().up().up().up()
          .c("publish-options")
          .c("x", { xmlns: "jabber:x:data", type: "submit" })
          .c("field", { var: "FORM_TYPE", type: "hidden" }).c("value").t("http://jabber.org/protocol/pubsub#publish-options").up().up()
          .c("field", { var: "pubsub#access_model" }).c("value").t("open");
        this._connection.sendIQ(iq.tree(), () => resolve(), () => reject(new Error("OMEMO bundle publish failed")));
      });
      return publish().catch(async () => {
        await this._configureOmemoNodeOpen(node);
        await publish();
      });
    };
    return Promise.allSettled(OMEMO_NAMESPACES.map((ns) => publishToNamespace(ns))).then((results) => {
      if (results.every((r) => r.status === "rejected")) {
        throw new Error("OMEMO bundle publish failed");
      }
    });
  }

  private _configureOmemoNodeOpen(node: string): Promise<void> {
    const iq = this._$iq({ type: "set" })
      .c("pubsub", { xmlns: "http://jabber.org/protocol/pubsub#owner" })
      .c("configure", { node })
      .c("x", { xmlns: "jabber:x:data", type: "submit" })
      .c("field", { var: "FORM_TYPE", type: "hidden" }).c("value").t("http://jabber.org/protocol/pubsub#node_config").up().up()
      .c("field", { var: "pubsub#access_model" }).c("value").t("open");
    return new Promise((resolve, reject) => {
      this._connection.sendIQ(iq.tree(), () => resolve(), () => reject(new Error("OMEMO PEP node configuration failed")));
    });
  }

  fetchOmemoBundle(jid: string, deviceId: number): Promise<OmemoBundle | null> {
    if (!this._connection) return Promise.resolve(null);
    const fetchFromNamespace = (namespace: string) =>
      new Promise<OmemoBundle | null>((resolve) => {
        const iq = this._$iq({ type: "get", to: jid })
          .c("pubsub", { xmlns: PUBSUB_NS })
          .c("items", { node: bundleNodeFor(namespace, deviceId) });
        this._connection.sendIQ(
          iq.tree(),
          (result: Element) => {
            const bundleNode = result.querySelector(`bundle[xmlns="${namespace}"]`);
            if (!bundleNode) {
              resolve(null);
              return;
            }
            const spk = bundleNode.querySelector("signedPreKeyPublic");
            const sig = bundleNode.querySelector("signedPreKeySignature");
            const ik = bundleNode.querySelector("identityKey");
            if (!spk?.textContent || !sig?.textContent || !ik?.textContent) {
              resolve(null);
              return;
            }
            const preKeys = Array.from(bundleNode.querySelectorAll("prekeys preKeyPublic"))
              .map((node) => {
                const preKeyId = Number.parseInt(node.getAttribute("preKeyId") ?? "", 10);
                const value = node.textContent?.trim() ?? "";
                if (!Number.isFinite(preKeyId) || !value) return null;
                return { preKeyId, value };
              })
              .filter((v): v is { preKeyId: number; value: string } => Boolean(v));
            resolve({
              deviceId,
              signedPreKeyId: Number.parseInt(spk.getAttribute("signedPreKeyId") ?? "1", 10) || 1,
              signedPreKeyPublic: spk.textContent.trim(),
              signedPreKeySignature: sig.textContent.trim(),
              identityKey: ik.textContent.trim(),
              preKeys,
            });
          },
          () => resolve(null)
        );
      });
    return Promise.all(OMEMO_NAMESPACES.map((ns) => fetchFromNamespace(ns))).then((bundles) =>
      bundles.find((bundle): bundle is OmemoBundle => Boolean(bundle)) ?? null
    );
  }

  fetchMAM(targetJid: string, options: { before?: string; limit?: number; start?: number; type?: "chat" | "groupchat" } = {}) {
    if (!this._connection) return;
    const queryId = crypto.randomUUID();
    const limit = options.limit ?? 30;
    const isGroupchat = options.type === "groupchat";

    const iq = this._$iq({ type: "set", to: isGroupchat ? targetJid : undefined })
      .c("query", { xmlns: "urn:xmpp:mam:2", queryid: queryId })
      .c("x", { xmlns: "jabber:x:data", type: "submit" })
      .c("field", { var: "FORM_TYPE", type: "hidden" }).c("value").t("urn:xmpp:mam:2").up().up()
      .c("field", { var: "with" }).c("value").t(targetJid).up().up();
    if (options.start) {
      iq.c("field", { var: "start" }).c("value").t(new Date(options.start).toISOString()).up().up();
    }
    iq.up().c("set", { xmlns: "http://jabber.org/protocol/rsm" })
      .c("max").t(String(limit));

    if (options.before) iq.up().c("before").t(options.before);

    const mamHandler = this._connection.addHandler((stanza: Element) => {
      const result = stanza.querySelector("result");
      if (!result || result.getAttribute("queryid") !== queryId) return true;
      const msg = result.querySelector("forwarded message");
      if (!msg) return true;
      const mamRetraction = Array.from(msg.children).find((child) => child.localName === "retract" && child.namespaceURI === "urn:xmpp:message-retract:1");
      if (mamRetraction) {
        this.emit("message.retracted", {
          accountId: this.config.accountId,
          messageId: mamRetraction.getAttribute("id"),
          from: msg.getAttribute("from") ?? "",
          to: msg.getAttribute("to") ?? "",
          type: msg.getAttribute("type") ?? "chat",
          realSenderJid: normalizeValidBareJid(msg.querySelector('x[xmlns="http://jabber.org/protocol/muc#user"] item[jid]')?.getAttribute("jid") ?? "") ?? undefined,
        });
        return true;
      }
      const body = msg.querySelector("body")?.textContent ?? "";
      const omemo = parseOmemoEnvelope(msg);
      if (!body && !omemo) return true;
      const forwarded = result.querySelector("forwarded") as Element | null;
      const timestamp = forwarded ? parseXmppDelayTimestamp(forwarded) : null;
      if (timestamp === null) return true;
      const xmppMsg: XmppMessage = {
        id: msg.getAttribute("id") ?? crypto.randomUUID(),
        from: msg.getAttribute("from") ?? "",
        to: msg.getAttribute("to") ?? "",
        body: body || "[OMEMO message]",
        timestamp,
        type: (msg.getAttribute("type") ?? "chat") as "chat" | "groupchat",
        stanzaId: result.getAttribute("id") ?? undefined,
        replyTo: msg.querySelector('reply[xmlns="urn:xmpp:reply:0"]')?.getAttribute("id") ?? undefined,
        omemo: omemo ?? undefined,
        realSenderJid: normalizeValidBareJid(msg.querySelector('x[xmlns="http://jabber.org/protocol/muc#user"] item[jid]')?.getAttribute("jid") ?? "") ?? undefined,
      };
      this.emit("mam.message", { accountId: this.config.accountId, message: xmppMsg, queryId });
      return true;
    }, null, "message");

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (mamHandler) {
        this._connection.deleteHandler(mamHandler);
      }
    };

    this._connection.sendIQ(iq.tree(), () => {
      cleanup();
      this.emit("mam.loaded", { accountId: this.config.accountId, targetJid, queryId });
    }, () => {
      cleanup();
      this.emit("error", { type: "mam_fetch_failed", accountId: this.config.accountId, targetJid, queryId });
    });
  }

  sendReaction(toJid: string, messageId: string, emojis: string[], type: "chat" | "groupchat" = "chat") {
    if (!this._connection || !this._connected) return;
    const msg = this._$msg({ to: toJid, type })
      .c("reactions", { xmlns: "urn:xmpp:reactions:0", id: messageId });
    emojis.forEach((emoji) => msg.c("reaction").t(emoji).up());
    this._connection.send(msg);
  }

  /**
   * Send a Jingle stanza (XEP-0166). The Jingle XML is built by the bridge
   * layer using sdpToJingleXml/candidateToJingleXml/terminateToJingleXml.
   *
   * Wraps the Jingle element in an IQ set and sends it.
   */
  async fetchIceServers(): Promise<IceServer[]> {
    if (!this._connection || !this._connected) return [];
    const domain = this.config.jid.split("@")[1]?.split("/")[0];
    if (!domain) return [];
    const request = (namespace: string) => new Promise<Element>((resolve, reject) => {
      const iq = this._$iq({ type: "get", to: domain }).c("services", { xmlns: namespace });
      this._connection.sendIQ(iq.tree(), resolve, reject, 8000);
    });
    let result: Element;
    try {
      result = await request("urn:xmpp:extdisco:2");
    } catch {
      try { result = await request("urn:xmpp:extdisco:1"); }
      catch { return []; }
    }
    return Array.from(result.getElementsByTagName("service"))
      .flatMap((service): IceServer[] => {
        const host = service.getAttribute("host");
        const type = service.getAttribute("type");
        const port = Number(service.getAttribute("port") || 3478);
        const transport = service.getAttribute("transport") || "udp";
        if (!host || !/^[a-z0-9.:-]+$/i.test(host) || !["stun", "turn", "turns"].includes(type ?? "") ||
            !Number.isInteger(port) || port < 1 || port > 65535 || !["udp", "tcp"].includes(transport)) return [];
        // Browsers reject ?transport= on STUN URLs; the query is TURN-only.
        const urls = type === "stun"
          ? `stun:${host}:${port}`
          : `${type}:${host}:${port}?transport=${transport}`;
        if (type === "stun") return [{ urls }];
        const username = service.getAttribute("username");
        const credential = service.getAttribute("password");
        return username && credential ? [{ urls, username, credential }] : [];
      });
  }

  sendJingle(peerJid: string, sid: string, jingleXml: string): void {
    if (!this._connection || !this._connected) return;
    // Parse the jingleXml string into an Element via DOMParser
    const doc = new DOMParser().parseFromString(jingleXml, "text/xml");
    const jingleEl = doc.documentElement;
    if (!jingleEl || jingleEl.localName !== "jingle") return;

    // Jingle IQs must reach a full resource; the bare JID is routed by some
    // servers to the account service instead of the active client.
    const barePeerJid = normalizeBareJid(peerJid);
    const recentResource = this._recentMessageFullJidByBare.get(barePeerJid);
    const available = this._availableFullJidsByBare.get(barePeerJid);
    const activeResource = available?.has(recentResource ?? "")
      ? recentResource
      : available?.size ? [...available][available.size - 1] : undefined;
    const targetJid = jingleEl.getAttribute("action") === "session-initiate"
      ? peerJid.includes("/") ? peerJid :
        activeResource ?? (available ? undefined : recentResource) ?? this._lastFullJidByBare.get(barePeerJid) ?? peerJid
      : peerJid.includes("/") ? peerJid : (activeResource ?? recentResource ?? this._lastFullJidByBare.get(barePeerJid) ?? peerJid);
    const action = jingleEl.getAttribute("action");
    const localFullJid = this._connection.jid;
    if (action === "session-initiate") {
      // XEP-0166 uses the initiating resource's full JID. A bare JID here
      // does not identify the endpoint Conversations must answer.
      if (localFullJid) jingleEl.setAttribute("initiator", localFullJid);
      jingleEl.removeAttribute("responder");
    } else if (action === "session-accept") {
      if (localFullJid) jingleEl.setAttribute("responder", localFullJid);
      jingleEl.removeAttribute("initiator");
    }
    const iq = this._$iq({ type: "set", to: targetJid, id: crypto.randomUUID() });
    // Append the jingle element to the IQ via cnode()
    iq.cnode(jingleEl as any);
    if (jingleEl.getAttribute("action") === "session-initiate") {
      this._connection.sendIQ(
        iq.tree(),
        () => {},
        (error: Element | null) => {
          const condition = error?.querySelector("error")?.firstElementChild?.localName ?? "timeout";
          this.emit("jingle.error", { accountId: this.config.accountId, sid, condition });
        },
        15000,
      );
    } else {
      this._connection.send(iq);
    }
  }

  async findJingleResource(peerJid: string, mediaTypes: ("audio" | "video")[]): Promise<string> {
    if (!this._connection || !this._connected) throw new Error("XMPP is not connected");
    const bare = normalizeBareJid(peerJid);
    const available = [...(this._availableFullJidsByBare.get(bare) ?? [])].reverse();
    const recent = this._recentMessageFullJidByBare.get(bare);
    const last = this._lastFullJidByBare.get(bare);
    const candidates = [...new Set([
      ...(peerJid.includes("/") ? [peerJid] : []),
      ...(recent && available.includes(recent) ? [recent] : []),
      ...available,
      ...(recent ? [recent] : []),
      ...(last ? [last] : []),
    ])];
    const required = [
      "urn:xmpp:jingle:1",
      "urn:xmpp:jingle:transports:ice-udp:1",
      "urn:xmpp:jingle:apps:rtp:1",
      "urn:xmpp:jingle:apps:dtls:0",
      ...mediaTypes.map((media) => `urn:xmpp:jingle:apps:rtp:${media}`),
    ];
    for (const resource of candidates) {
      const supportsCall = await new Promise<boolean>((resolve) => {
        const iq = this._$iq({ type: "get", to: resource, id: crypto.randomUUID() })
          .c("query", { xmlns: "http://jabber.org/protocol/disco#info" });
        this._connection.sendIQ(iq.tree(), (reply: Element) => {
          const features = new Set(Array.from(reply.getElementsByTagName("feature"))
            .map((feature) => feature.getAttribute("var")));
          resolve(required.every((feature) => features.has(feature)));
        }, () => resolve(false), 5000);
      });
      if (supportsCall) return resource;
    }
    throw new Error("No online device supports this call");
  }

  proposeJingleCall(peerJid: string, mediaTypes: ("audio" | "video")[], sid: string): Promise<string> {
    if (!this._connection || !this._connected) return Promise.reject(new Error("XMPP is not connected"));
    const bareJid = normalizeBareJid(peerJid);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingCallProposals.delete(sid);
        reject(new Error("The contact did not answer the call"));
      }, 45000);
      this._pendingCallProposals.set(sid, { bareJid, resolve, reject, timer });
      const message = this._$msg({ to: bareJid, type: "chat", id: crypto.randomUUID() })
        .c("propose", { xmlns: "urn:xmpp:jingle-message:0", id: sid });
      mediaTypes.forEach((media) => message.c("description", {
        xmlns: "urn:xmpp:jingle:apps:rtp:1", media,
      }).up());
      message.up().c("store", { xmlns: "urn:xmpp:hints" });
      this._connection.send(message);
    });
  }

  // ============================================================
  // XEP-0084 PEP User Avatar
  // ============================================================
  /**
   * Publish own avatar via PEP. Accepts PNG/JPEG data URL or raw bytes.
   * Computes SHA-1 hash and publishes to:
   *   urn:xmpp:avatar:data (the bytes, keyed by hash)
   *   urn:xmpp:avatar:metadata (info: hash, MIME, size, dims)
   */
  async publishPepAvatar(imageBytes: Uint8Array, mimeType: string = "image/png", width?: number, height?: number) {
    if (!this._connection || !this._connected) return;
    // SHA-1 hash
    const imageBuffer = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength
    ) as ArrayBuffer;
    const hashBuf = await crypto.subtle.digest("SHA-1", imageBuffer);
    const hashBytes = new Uint8Array(hashBuf);
    const hashHex = Array.from(hashBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    // base64 encode
    let bin = "";
    for (let i = 0; i < imageBytes.byteLength; i++) bin += String.fromCharCode(imageBytes[i]);
    const dataB64 = btoa(bin);

    // Publish data
    const dataIq = this._$iq({ type: "set" })
      .c("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" })
      .c("publish", { node: "urn:xmpp:avatar:data" })
      .c("item", { id: hashHex })
      .c("data", { xmlns: "urn:xmpp:avatar:data" }).t(dataB64);
    await new Promise<void>((resolve) => {
      this._connection.sendIQ(dataIq.tree(), () => resolve(), () => resolve());
    });

    // Publish metadata
    const metaAttrs: Record<string, string> = {
      bytes: String(imageBytes.byteLength),
      id: hashHex,
      type: mimeType,
    };
    if (width) metaAttrs.width = String(width);
    if (height) metaAttrs.height = String(height);
    const metaIq = this._$iq({ type: "set" })
      .c("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" })
      .c("publish", { node: "urn:xmpp:avatar:metadata" })
      .c("item", { id: hashHex })
      .c("metadata", { xmlns: "urn:xmpp:avatar:metadata" })
      .c("info", metaAttrs);
    await new Promise<void>((resolve) => {
      this._connection.sendIQ(metaIq.tree(), () => resolve(), () => resolve());
    });
  }

  // ============================================================
  // Generic PEP node publish / fetch (XEP-0163)
  // Used by OMEMO (devicelist, bundles) and other PEP-based features.
  // ============================================================
  async publishPepNode(node: string, item: any, itemId: string = "current"): Promise<void> {
    if (!this._connection || !this._connected) throw new Error("Not connected");
    const iq = this._$iq({ type: "set" })
      .c("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" })
      .c("publish", { node })
      .c("item", { id: itemId });
    // Build the inner item XML based on item.type
    if (item.type === "devicelist") {
      const list = iq.c("list", { xmlns: "eu.siacs.conversations.axolotl" });
      for (const id of item.deviceIds as number[]) {
        list.c("device", { id: String(id) }).up();
      }
    } else if (item.type === "bundle") {
      const b = item.bundle;
      const bn = iq.c("bundle", { xmlns: "eu.siacs.conversations.axolotl" });
      bn.c("signedPreKeyPublic", { signedPreKeyId: String(b.signedPreKeyId) })
        .t(arrayBufferToBase64(b.signedPreKey)).up();
      bn.c("signedPreKeySignature").t(arrayBufferToBase64(b.signedPreKeySignature)).up();
      bn.c("identityKey").t(arrayBufferToBase64(b.identityKey)).up();
      const pks = bn.c("prekeys");
      for (const pk of b.preKeys) {
        pks.c("preKeyPublic", { preKeyId: String(pk.keyId) })
          .t(arrayBufferToBase64(pk.publicKey)).up();
      }
    } else if (item.type === "raw" && item.xml) {
      iq.cnode(item.xml);
    }
    await new Promise<void>((resolve, reject) => {
      this._connection.sendIQ(iq.tree(), () => resolve(), (err: any) => reject(err));
    });
  }

  async fetchPepNode(jid: string, node: string): Promise<Element | null> {
    if (!this._connection || !this._connected) return null;
    return new Promise((resolve) => {
      const iq = this._$iq({ type: "get", to: jid })
        .c("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" })
        .c("items", { node });
      this._connection.sendIQ(iq.tree(), (result: Element) => {
        resolve(result);
      }, () => resolve(null));
    });
  }

  /**
   * Fetch a peer's PEP avatar. Returns data URL or null if not published.
   */
  async fetchPepAvatar(peerJid: string): Promise<string | null> {
    if (!this._connection || !this._connected) return null;
    return new Promise((resolve) => {
      // First fetch metadata to get hash
      const metaIq = this._$iq({ type: "get", to: peerJid })
        .c("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" })
        .c("items", { node: "urn:xmpp:avatar:metadata" });
      this._connection.sendIQ(metaIq.tree(), (metaResult: Element) => {
        const info = metaResult.querySelector("metadata info");
        const hash = info?.getAttribute("id");
        const mime = info?.getAttribute("type") ?? "image/png";
        if (!hash) { resolve(null); return; }

        // Then fetch data by hash
        const dataIq = this._$iq({ type: "get", to: peerJid })
          .c("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" })
          .c("items", { node: "urn:xmpp:avatar:data" })
          .c("item", { id: hash });
        this._connection.sendIQ(dataIq.tree(), (dataResult: Element) => {
          const dataB64 = dataResult.querySelector("data")?.textContent?.trim();
          if (!dataB64) { resolve(null); return; }
          resolve(`data:${mime};base64,${dataB64}`);
        }, () => resolve(null));
      }, () => resolve(null));
    });
  }

  // ============================================================
  // XEP-0280 Message Carbons
  // ============================================================
  private _enableCarbons() {
    if (!this._connection) return;
    const iq = this._$iq({ type: "set", id: "carbons-enable" })
      .c("enable", { xmlns: "urn:xmpp:carbons:2" });
    this._connection.sendIQ(iq.tree(), () => {
      // success - server confirmed carbons enabled
    }, () => {
      // failed - server may not support carbons; non-fatal
    });
  }

  // ============================================================
  // XEP-0352 Client State Indication
  // ============================================================
  private _csiActive = true;
  private _csiVisibilityHandler: (() => void) | null = null;

  private _setupCsiHandling() {
    if (typeof document === "undefined") return;
    this._csiVisibilityHandler = () => {
      if (document.hidden) this.setInactive();
      else this.setActive();
    };
    document.addEventListener("visibilitychange", this._csiVisibilityHandler);
  }

  setActive() {
    if (!this._connection || !this._connected || this._csiActive) return;
    this._csiActive = true;
    const stanza = this._buildElement("active", { xmlns: "urn:xmpp:csi:0" });
    if (stanza) this._connection.send(stanza);
  }

  setInactive() {
    if (!this._connection || !this._connected || !this._csiActive) return;
    this._csiActive = false;
    const stanza = this._buildElement("inactive", { xmlns: "urn:xmpp:csi:0" });
    if (stanza) this._connection.send(stanza);
  }

  private _buildElement(name: string, attrs: Record<string, string>): Element | null {
    if (!this._Strophe) return null;
    return this._Strophe.xmlElement(name, attrs as any);
  }

  // ============================================================
  // XEP-0030 Service Discovery + XEP-0115 Entity Capabilities
  // ============================================================
  private static readonly SUPPORTED_FEATURES = [
    "http://jabber.org/protocol/disco#info",
    "http://jabber.org/protocol/disco#items",
    "urn:xmpp:carbons:2",
    "urn:xmpp:csi:0",
    "urn:xmpp:mam:2",
    "urn:xmpp:ping",
    "urn:xmpp:receipts",
    "urn:xmpp:chat-markers:0",
    "urn:xmpp:reactions:0",
    "urn:xmpp:reply:0",
    "urn:xmpp:message-correct:0",
    "urn:xmpp:message-retract:1",
    "urn:xmpp:fasten:0",
    // Conversations requires these XEP-0166/RTP/ICE/DTLS features in
    // XEP-0115 caps before it will offer an audio or video call.
    "urn:xmpp:jingle:1",
    "urn:xmpp:jingle:apps:rtp:1",
    "urn:xmpp:jingle:apps:rtp:audio",
    "urn:xmpp:jingle:apps:rtp:video",
    "urn:xmpp:jingle:apps:dtls:0",
    "urn:xmpp:jingle:transports:ice-udp:1",
    "urn:xmpp:avatar:metadata+notify",
    "urn:xmpp:avatar:data",
    "urn:xmpp:blocking",
    "http://jabber.org/protocol/muc",
    "http://jabber.org/protocol/chatstates",
    "vcard-temp",
    "jabber:x:conference",
  ];

  /**
   * Compute the XEP-0115 caps verification string.
   * Format: SHA-1 of "client/type/lang/name<feature1<feature2<...<"
   */
  private async _computeCapsHash(): Promise<string> {
    const features = [...XmppClient.SUPPORTED_FEATURES].sort();
    const idString = "client/web//Lyao Talk<" + features.join("<") + "<";
    const buf = new TextEncoder().encode(idString);
    const hash = await crypto.subtle.digest("SHA-1", buf);
    // base64 encode
    const bytes = new Uint8Array(hash);
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /**
   * Setup handler for incoming disco#info queries about our capabilities.
   */
  private _setupDiscoHandler() {
    if (!this._connection) return;
    this._connection.addHandler((iq: Element) => {
      const fromIq = iq.getAttribute("from") ?? "";
      const idIq = iq.getAttribute("id") ?? "";
      const requestedNode = iq.querySelector("query")?.getAttribute("node");
      const reply = this._$iq({ type: "result", to: fromIq, id: idIq })
        .c("query", {
          xmlns: "http://jabber.org/protocol/disco#info",
          ...(requestedNode ? { node: requestedNode } : {}),
        })
        .c("identity", { category: "client", type: "web", name: "Lyao Talk" }).up();
      for (const feature of XmppClient.SUPPORTED_FEATURES) {
        reply.c("feature", { var: feature }).up();
      }
      this._connection.send(reply);
      return true;
    }, "http://jabber.org/protocol/disco#info", "iq", "get");
  }

  private _startKeepalive() {
    if (this._keepaliveTimer) return;
    const interval = this.config.keepaliveIntervalMs ?? 45000;
    const timeout = this.config.keepaliveTimeoutMs ?? 20000;
    let consecutiveFailures = 0;
    // Keep websocket/NAT path alive; some links recycle idle WS within minutes.
    this._keepaliveTimer = setInterval(() => {
      if (!this._connection || !this._connected) return;
      try {
        const domain = this.config.jid.split("@")[1]?.split("/")[0] ?? "";
        if (!domain) return;
        const id = `cw-ping-${Date.now()}`;
        const start = Date.now();
        const iq = this._$iq({ type: "get", to: domain, id })
          .c("ping", { xmlns: "urn:xmpp:ping" });
        this._connection.sendIQ(
          iq,
          // success
          () => {
            if (consecutiveFailures > 0 && this._connected) {
              this.emit("connection.changed", { status: "verified", accountId: this.config.accountId });
            }
            consecutiveFailures = 0;
            const rtt = Date.now() - start;
            // Log only slow pings to keep logs quiet on healthy links
            if (rtt > 5000) {
              // eslint-disable-next-line no-console
              console.warn(`[XMPP] slow keepalive id=${id} rtt=${rtt}ms`, {
                accountId: this.config.accountId,
              });
            }
          },
          // failure / timeout
          (err: any) => {
            if (!this._connected) return;
            consecutiveFailures++;
            if (consecutiveFailures === 1) {
              // A timed-out ping means the connection is unverified. Remove the
              // online badge now, before the second failure forces reconnect.
              this.emit("connection.changed", { status: "verifying", accountId: this.config.accountId });
            }
            // eslint-disable-next-line no-console
            console.warn(`[XMPP] keepalive-fail id=${id} consecutive=${consecutiveFailures}`, {
              accountId: this.config.accountId,
              err: err?.toString?.() ?? String(err),
            });
            // Two failed pings in a row → link is dead; force disconnect so
            // the bridge-level reconnect strategy kicks in. Strophe sometimes
            // takes minutes to notice a half-open WebSocket on its own.
            if (consecutiveFailures >= 2 && this._connection) {
              // eslint-disable-next-line no-console
              console.warn("[XMPP] keepalive-dead-link forcing disconnect", {
                accountId: this.config.accountId,
              });
              try {
                this._connection.disconnect("keepalive-failed");
              } catch {}
            }
          },
          timeout,
        );
      } catch {
        // Keepalive is best-effort.
      }
    }, interval);
  }

  private _stopKeepalive() {
    if (!this._keepaliveTimer) return;
    clearInterval(this._keepaliveTimer);
    this._keepaliveTimer = null;
  }

  disconnect(preserveResumableSession = false) {
    for (const pending of this._pendingCallProposals.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("XMPP disconnected during call setup"));
    }
    this._pendingCallProposals.clear();
    // Clean up CSI visibility listener
    if (this._csiVisibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this._csiVisibilityHandler);
      this._csiVisibilityHandler = null;
    }
    // Strophe.js manages its own Stream Management state.
    this._stopKeepalive();
    if (this._connection) {
      const socket = this._connection._proto?.socket;
      const transportStillOpen = socket?.readyState === 0 || socket?.readyState === 1;
      if (preserveResumableSession && !transportStillOpen) {
        // The transport has failed. A graceful disconnect would erase
        // Strophe's persisted SM counters and prevent <resume/> on reconnect.
        this._connection = null;
      } else {
        // A replacement must close an open/connecting socket. Otherwise each
        // retry leaves another live c2s session behind on Prosody.
        this._connection.disconnect();
        this._connection = null;
      }
      this._connected = false;
    }
  }
}

const clients: Map<string, XmppClient> = new Map();

export function getClient(accountId: string): XmppClient | undefined {
  return clients.get(accountId);
}

export function createClient(config: XmppClientConfig): XmppClient {
  clients.get(config.accountId)?.disconnect();
  const client = new XmppClient(config);
  clients.set(config.accountId, client);
  return client;
}

export function destroyClient(accountId: string, preserveResumableSession = false) {
  clients.get(accountId)?.disconnect(preserveResumableSession);
  clients.delete(accountId);
}

export function getAllClients(): XmppClient[] {
  return Array.from(clients.values());
}


