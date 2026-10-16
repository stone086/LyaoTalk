/**
 * omemo/index.ts - High-level OMEMO API used by xmppAdapter and xmppBridge.
 *
 * This is the integration point between the XMPP layer and the OMEMO crypto layer.
 *
 * Interop status (XEP-0384 v0.3 namespace `eu.siacs.conversations.axolotl`):
 *   - Outbound message structure: <body fallback> + <encryption xmlns="urn:xmpp:eme:0"
 *     name="OMEMO"/> + <store xmlns="urn:xmpp:hints"/> + <encrypted ...>
 *     This is what Conversations, Gajim, Movim recognize as OMEMO; receivers
 *     show "🔒 OMEMO" indicator and the encrypted body, never the fallback hint.
 *   - Inbound: when <encrypted> is present we ALWAYS discard the body (which is
 *     just the fallback hint) before any decrypt attempt. So even if decrypt
 *     fails the user never sees "your client doesn't seem to support OMEMO".
 *   - Sender's own other devices: each outbound message is encrypted for the
 *     sender's own devicelist as well as the peer's, per XEP-0384 §4.2, so
 *     that another logged-in client of the same account can decrypt sent items.
 *   - 1:1 only: MUC OMEMO is NOT implemented. Group chats fall back to plain
 *     XMPP unless the user explicitly opted in for non-OMEMO-aware peers.
 *   - Decrypt fallback: libsignal SessionCipher first; if that fails (no
 *     session, missing prekey, etc.), tries the legacy custom-protocol path
 *     in services/e2ee.ts. Failures emit `[OMEMO] omemo-decrypt-fail` to
 *     console with structured context (sender devid, namespace, reason).
 *
 * To enable real OMEMO end-to-end encryption with Conversations / Gajim:
 *
 *   1. After XMPP login, call initOmemo(accountId, xmppClient).
 *      This generates keys (if first time) and publishes our bundle to PEP.
 *
 *   2. Before sending an encrypted message:
 *      a. Call fetchPeerDevices(peerJid) to get the peer's device list
 *      b. For any device we don't have a session with, call fetchPeerBundle()
 *         and establishSession()
 *      c. Call encryptForPeer(peerJid, plaintext) to build the envelope
 *      d. Serialize envelope to <encrypted xmlns="eu.siacs.conversations.axolotl">
 *
 *   3. On receiving an OMEMO message:
 *      a. Parse the <encrypted> stanza into an envelope
 *      b. Call decryptIncoming(senderJid, envelope) to recover plaintext
 *      c. If decryption used a PreKey, replenish + republish bundle
 */

export { OmemoStore } from "./store";
export {
  initializeOmemoKeys,
  buildOwnBundle,
  replenishPreKeys,
  getIdentityFingerprint,
  NS_DEVICELIST,
  NS_BUNDLES,
} from "./keys";
export type { OmemoBundle } from "./keys";
export {
  establishSession,
  encryptForDevices,
  decryptEnvelope,
  NS_OMEMO,
} from "./encrypt";
export type { EncryptedEnvelope } from "./encrypt";

import { initializeOmemoKeys, buildOwnBundle, NS_DEVICELIST, NS_BUNDLES } from "./keys";

/**
 * Initialize OMEMO for an account and publish our bundle to PEP.
 * Should be called once per session, after XMPP connection is established.
 *
 * @param accountId   LyaoTalk account id (used to namespace keys in IndexedDB)
 * @param xmppClient  Connected XMPP client with publishPepNode / fetchPepNode
 */
export async function initOmemo(
  accountId: string,
  xmppClient: {
    publishPepNode: (node: string, item: any, itemId?: string) => Promise<void>;
    fetchPepNode: (jid: string, node: string) => Promise<any>;
  }
): Promise<{ deviceId: number }> {
  const { deviceId } = await initializeOmemoKeys(accountId);

  // Publish device list (containing just our device for now).
  // In a multi-device setup, this list grows.
  // The XML structure is:
  //   <list xmlns="eu.siacs.conversations.axolotl">
  //     <device id="..."/>
  //   </list>
  await xmppClient.publishPepNode(NS_DEVICELIST, {
    type: "devicelist",
    deviceIds: [deviceId],
  });

  // Publish our bundle.
  // The XML structure is:
  //   <bundle xmlns="eu.siacs.conversations.axolotl">
  //     <signedPreKeyPublic signedPreKeyId="...">base64</signedPreKeyPublic>
  //     <signedPreKeySignature>base64</signedPreKeySignature>
  //     <identityKey>base64</identityKey>
  //     <prekeys>
  //       <preKeyPublic preKeyId="...">base64</preKeyPublic>
  //       ...
  //     </prekeys>
  //   </bundle>
  const bundle = await buildOwnBundle(accountId);
  await xmppClient.publishPepNode(`${NS_BUNDLES}:${deviceId}`, {
    type: "bundle",
    bundle,
  });

  return { deviceId };
}
