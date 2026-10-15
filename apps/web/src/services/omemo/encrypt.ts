/**
 * omemo/encrypt.ts - OMEMO encryption/decryption using libsignal.
 *
 * This is the single production implementation. It uses:
 *   - @privacyresearch/libsignal-protocol-typescript for Signal sessions
 *   - WebCrypto API for AES-GCM
 *   - OmemoStore (IndexedDB-backed) for key persistence
 *
 * Exported functions: establishSession, encryptForDevices, decryptEnvelope
 */
import { SignalProtocolAddress } from "@privacyresearch/libsignal-protocol-typescript";
import { SessionBuilder } from "@privacyresearch/libsignal-protocol-typescript/lib/session-builder";
import { SessionCipher } from "@privacyresearch/libsignal-protocol-typescript/lib/session-cipher";
import { OmemoStore } from "./store";

export const NS_OMEMO = "eu.siacs.conversations.axolotl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface EncryptedEnvelope {
  sid: number;
  iv: ArrayBuffer;
  payload: ArrayBuffer;
  keys: {
    rid: number;
    isPreKey: boolean;
    body: ArrayBuffer;
  }[];
}

export interface PeerBundleInput {
  deviceId: number;
  identityKey: ArrayBuffer;
  signedPreKeyId: number;
  signedPreKey: ArrayBuffer;
  signedPreKeySignature: ArrayBuffer;
  preKey?: { keyId: number; publicKey: ArrayBuffer };
}

export interface PeerDeviceInput {
  peerJid: string;
  deviceId: number;
}

// ---------------------------------------------------------------------------
// Internal helpers — WebCrypto + ArrayBuffer utilities
// ---------------------------------------------------------------------------
function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function generateAesKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 128 },
    true,
    ["encrypt", "decrypt"],
  );
}

async function exportAesKey(key: CryptoKey): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.exportKey("raw", key);
}

async function importAesKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 128 },
    false,
    ["decrypt"],
  );
}

async function encryptAesGcm(
  key: CryptoKey,
  iv: Uint8Array | ArrayBuffer,
  plaintext: Uint8Array,
): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toOwned(iv), tagLength: 128 },
    key,
    toOwned(plaintext),
  );
}

async function decryptAesGcm(
  key: CryptoKey,
  iv: Uint8Array | ArrayBuffer,
  ciphertextWithTag: ArrayBuffer,
): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toOwned(iv), tagLength: 128 },
    key,
    ciphertextWithTag,
  );
}

function stringToArrayBuffer(s: string): ArrayBuffer {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes.buffer;
}

function arrayBufferToString(b: ArrayBuffer): string {
  const bytes = new Uint8Array(b);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function toOwned(view: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (view instanceof ArrayBuffer) return view;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Establish a libsignal session with a peer device using their published bundle.
 * Required before the first message to that device.
 */
export async function establishSession(
  accountId: string,
  peerJid: string,
  peerBundle: PeerBundleInput,
): Promise<void> {
  const store = new OmemoStore(accountId);
  const address = new SignalProtocolAddress(peerJid, peerBundle.deviceId);
  const builder = new SessionBuilder(store as any, address);

  await builder.processPreKey({
    registrationId: peerBundle.deviceId,
    identityKey: peerBundle.identityKey,
    signedPreKey: {
      keyId: peerBundle.signedPreKeyId,
      publicKey: peerBundle.signedPreKey,
      signature: peerBundle.signedPreKeySignature,
    },
    preKey: peerBundle.preKey,
  });
}

/**
 * Encrypt a plaintext for one or more peer devices.
 * Returns an OMEMO envelope ready for stanza serialization.
 *
 * Follows XEP-0384 (OMEMO 0.3+): the AES-GCM auth tag is appended to the
 * AES key before wrapping with Signal, so the recipient can verify integrity.
 */
export async function encryptForDevices(
  accountId: string,
  ownDeviceId: number,
  plaintext: string,
  peerDevices: PeerDeviceInput[],
): Promise<EncryptedEnvelope> {
  const store = new OmemoStore(accountId);

  // Generate AES key + IV
  const aesKey = await generateAesKey();
  const iv = randomBytes(16);

  // Encrypt plaintext with AES-GCM
  const encoder = new TextEncoder();
  const ciphertext = await encryptAesGcm(aesKey, iv, encoder.encode(plaintext));

  // GCM auth tag is appended to ciphertext by WebCrypto;
  // XEP-0384 wants tag concatenated with the AES key when wrapping.
  const aesKeyRaw = await exportAesKey(aesKey);
  const ctBytes = new Uint8Array(ciphertext);
  const payload = ctBytes.slice(0, ctBytes.length - 16);
  const tag = ctBytes.slice(ctBytes.length - 16);

  // Wrap: AES key || tag (32 bytes) is encrypted for each recipient device
  const keyAndTag = new Uint8Array(aesKeyRaw.byteLength + tag.byteLength);
  keyAndTag.set(new Uint8Array(aesKeyRaw), 0);
  keyAndTag.set(tag, aesKeyRaw.byteLength);

  const keys: EncryptedEnvelope["keys"] = [];
  for (const { peerJid, deviceId } of peerDevices) {
    const address = new SignalProtocolAddress(peerJid, deviceId);
    const cipher = new SessionCipher(store as any, address);
    const wrapped = await cipher.encrypt(keyAndTag.buffer);
    keys.push({
      rid: deviceId,
      isPreKey: wrapped.type === 3, // 3 = PreKeyWhisperMessage
      body: stringToArrayBuffer(wrapped.body ?? ""),
    });
  }

  return {
    sid: ownDeviceId,
    iv: toOwned(iv),
    payload: toOwned(payload),
    keys,
  };
}

/**
 * Decrypt an incoming OMEMO envelope addressed to us.
 * Returns the plaintext or null if no key for our device.
 */
export async function decryptEnvelope(
  accountId: string,
  ownDeviceId: number,
  senderJid: string,
  envelope: EncryptedEnvelope,
): Promise<string | null> {
  const store = new OmemoStore(accountId);
  const ourKey = envelope.keys.find((k) => k.rid === ownDeviceId);
  if (!ourKey) return null;

  // Decrypt the wrapped AES key + GCM tag
  const address = new SignalProtocolAddress(senderJid, envelope.sid);
  const cipher = new SessionCipher(store as any, address);
  let keyAndTag: ArrayBuffer;
  if (ourKey.isPreKey) {
    keyAndTag = await cipher.decryptPreKeyWhisperMessage(
      arrayBufferToString(ourKey.body),
      "binary",
    );
  } else {
    keyAndTag = await cipher.decryptWhisperMessage(
      arrayBufferToString(ourKey.body),
      "binary",
    );
  }

  // Split into AES key (16 bytes) + tag (16 bytes)
  const ktBytes = new Uint8Array(keyAndTag);
  const aesKeyRaw = ktBytes.slice(0, 16);
  const tag = ktBytes.slice(16, 32);

  // Reconstruct ciphertext + tag for AES-GCM decrypt
  const payloadBytes = new Uint8Array(envelope.payload);
  const ctWithTag = new Uint8Array(payloadBytes.byteLength + tag.byteLength);
  ctWithTag.set(payloadBytes, 0);
  ctWithTag.set(tag, payloadBytes.byteLength);

  const aesKey = await importAesKey(toOwned(aesKeyRaw));
  const decrypted = await decryptAesGcm(aesKey, envelope.iv, toOwned(ctWithTag));

  return new TextDecoder().decode(decrypted);
}
