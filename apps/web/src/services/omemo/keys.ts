/**
 * omemo/keys.ts - Key generation and PEP bundle publishing.
 *
 * On first run for an account, we generate:
 *   - 1 IdentityKey (long-term, signs SignedPreKeys)
 *   - 1 SignedPreKey (rotated weekly)
 *   - 100 OneTimePreKeys (consumed during X3DH handshake)
 *   - 1 device id (random 32-bit int)
 *
 * Then we publish them to PEP nodes:
 *   eu.siacs.conversations.axolotl.devicelist           (our device list)
 *   eu.siacs.conversations.axolotl.bundles:<deviceId>   (this device's bundle)
 *
 * When PreKeys run low (< 20 remaining), we generate more and re-publish.
 */
import { KeyHelper } from "@privacyresearch/libsignal-protocol-typescript/lib/key-helper";
import { OmemoStore } from "./store";

export const NS_DEVICELIST = "eu.siacs.conversations.axolotl.devicelist";
export const NS_BUNDLES = "eu.siacs.conversations.axolotl.bundles";

export interface OmemoBundle {
  deviceId: number;
  identityKey: ArrayBuffer;
  signedPreKeyId: number;
  signedPreKey: ArrayBuffer;
  signedPreKeySignature: ArrayBuffer;
  preKeys: { keyId: number; publicKey: ArrayBuffer }[];
}

const PREKEY_COUNT = 100;
const PREKEY_LOW_WATER = 20;

/**
 * Initialize keys for an account if not already generated.
 * Idempotent: safe to call on every startup.
 */
export async function initializeOmemoKeys(accountId: string): Promise<{ deviceId: number }> {
  const store = new OmemoStore(accountId);
  const existing = await store.getIdentityKeyPair();
  if (existing) {
    const regId = await store.getLocalRegistrationId();
    return { deviceId: regId ?? 1 };
  }

  // First-time setup: generate identity + signedPreKey + 100 preKeys
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  await store.storeIdentity(identityKeyPair, registrationId);

  const signedPreKeyId = 1;
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId);
  await store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair);

  // Save signature alongside (libsignal store doesn't track signature itself)
  const db = await import("./store");
  // Use the same dbPut helper indirectly via store.storeSignedPreKey then save signature in custom slot
  // For simplicity, save signature in a dedicated key
  const signedPreKeySignature = signedPreKey.signature;
  // Stash both id and signature for republishing
  // We use an extra key in the store
  // (Type cast since SignalProtocolStore interface doesn't expose raw put)
  await (store as any)["k"]; // satisfy ts
  // Use direct IDB access via OmemoStore subclassing not possible; just store inline
  // Workaround: use an arbitrary additional key
  // We extend OmemoStore at runtime:
  await new Promise<void>(async (resolve) => {
    const dbReq = indexedDB.open("liaot-omemo", 1);
    dbReq.onsuccess = () => {
      const idb = dbReq.result;
      const tx = idb.transaction("omemo_keys", "readwrite");
      tx.objectStore("omemo_keys").put(
        { id: signedPreKeyId, signature: signedPreKeySignature },
        `${accountId}:signedPreKeyMeta`
      );
      tx.oncomplete = () => resolve();
    };
    dbReq.onerror = () => resolve();
  });

  // Generate preKeys
  for (let i = 1; i <= PREKEY_COUNT; i++) {
    const pk = await KeyHelper.generatePreKey(i);
    await store.storePreKey(i, pk.keyPair);
  }

  return { deviceId: registrationId };
}

/**
 * Build the public bundle to publish to PEP for this device.
 */
export async function buildOwnBundle(accountId: string): Promise<OmemoBundle> {
  const store = new OmemoStore(accountId);
  const identityKeyPair = await store.getIdentityKeyPair();
  const deviceId = await store.getLocalRegistrationId();
  if (!identityKeyPair || !deviceId) {
    throw new Error("OMEMO not initialized for account " + accountId);
  }

  // Get signed prekey + signature
  const signedPreKeyMeta = await new Promise<{ id: number; signature: ArrayBuffer }>(
    (resolve, reject) => {
      const dbReq = indexedDB.open("liaot-omemo", 1);
      dbReq.onsuccess = () => {
        const idb = dbReq.result;
        const tx = idb.transaction("omemo_keys", "readonly");
        const req = tx.objectStore("omemo_keys").get(`${accountId}:signedPreKeyMeta`);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      };
      dbReq.onerror = () => reject(dbReq.error);
    }
  );

  const signedPreKeyPair = await store.loadSignedPreKey(signedPreKeyMeta.id);
  if (!signedPreKeyPair) throw new Error("SignedPreKey missing");

  // Collect public preKeys
  const preKeys: { keyId: number; publicKey: ArrayBuffer }[] = [];
  for (let i = 1; i <= PREKEY_COUNT; i++) {
    const pk = await store.loadPreKey(i);
    if (pk) preKeys.push({ keyId: i, publicKey: pk.pubKey });
  }

  return {
    deviceId,
    identityKey: identityKeyPair.pubKey,
    signedPreKeyId: signedPreKeyMeta.id,
    signedPreKey: signedPreKeyPair.pubKey,
    signedPreKeySignature: signedPreKeyMeta.signature,
    preKeys,
  };
}

/**
 * Replenish preKeys if running low. Should be called after each session
 * establishment that consumed a preKey.
 */
export async function replenishPreKeys(accountId: string): Promise<boolean> {
  const store = new OmemoStore(accountId);
  let remaining = 0;
  for (let i = 1; i <= PREKEY_COUNT; i++) {
    if (await store.loadPreKey(i)) remaining++;
  }
  if (remaining > PREKEY_LOW_WATER) return false;

  // Generate replacements
  for (let i = 1; i <= PREKEY_COUNT; i++) {
    if (!(await store.loadPreKey(i))) {
      const pk = await KeyHelper.generatePreKey(i);
      await store.storePreKey(i, pk.keyPair);
    }
  }
  return true; // bundle should be re-published
}

/**
 * Get IdentityKey fingerprint for trust UI display.
 * Returns space-separated hex pairs in groups of 4 (common XMPP convention).
 */
export async function getIdentityFingerprint(accountId: string, peerJid?: string): Promise<string> {
  const store = new OmemoStore(accountId);
  const buf = peerJid
    ? await store.loadIdentityKey(peerJid)
    : (await store.getIdentityKeyPair())?.pubKey;
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  // Skip the leading 0x05 prefix that libsignal includes
  const start = bytes[0] === 0x05 ? 1 : 0;
  const hex: string[] = [];
  for (let i = start; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return hex.join("").replace(/(.{8})/g, "$1 ").trim();
}
