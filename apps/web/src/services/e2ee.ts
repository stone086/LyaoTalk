import { normalizeBareJid } from "@/utils/helpers";

const KEY_PREFIX = "liaot-e2ee-keypair:";
const PEER_PREFIX = "liaot-e2ee-peer:";
const DEVICE_PREFIX = "liaot-e2ee-device:";
const BUNDLE_PREFIX = "liaot-e2ee-bundle:";
const BUNDLE_SECRET_PREFIX = "liaot-e2ee-bundle-secret:";
const SESSION_PREFIX = "liaot-e2ee-session:";
const KEY_EXCHANGE_PREFIX = "[[E2EEKEY1]]";
const CIPHER_PREFIX = "[[E2EE1]]";
const SECURE_DB_NAME = "liaot-secure";
const SECURE_DB_VERSION = 1;
const SECURE_STORE_NAME = "securekv";

export const OMEMO_NAMESPACE_LEGACY = "eu.siacs.conversations.axolotl";
export const OMEMO_NAMESPACE_MODERN = "urn:xmpp:omemo:2";
export const OMEMO_SUPPORTED_NAMESPACES = [OMEMO_NAMESPACE_MODERN, OMEMO_NAMESPACE_LEGACY] as const;
export const OMEMO_NAMESPACE = OMEMO_NAMESPACE_LEGACY;

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

interface StoredKeyPair {
  privateJwk: JsonWebKey;
  publicRawB64: string;
}

interface PeerKeyInfo {
  publicRawB64: string;
  deviceId?: number;
}

interface KeyExchangeInfo {
  publicRawB64: string;
  deviceId?: number;
}

interface LocalBundleSecret {
  signedPreKeyPrivateJwk: JsonWebKey;
  preKeyPrivates: Record<string, JsonWebKey>;
}

interface SessionState {
  peer: string;
  senderDeviceId: number;
  rootKey: string;
  sendChain: string;
  recvChain: string;
  sendCounter: number;
  recvCounter: number;
}

const bundleSecretCache = new Map<string, Record<string, LocalBundleSecret>>();
const sessionCache = new Map<string, Record<string, SessionState>>();

function openSecureStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SECURE_DB_NAME, SECURE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SECURE_STORE_NAME)) {
        db.createObjectStore(SECURE_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open secure store"));
  });
}

async function secureGet(key: string): Promise<string | null> {
  const db = await openSecureStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECURE_STORE_NAME, "readonly");
    const store = tx.objectStore(SECURE_STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
    req.onerror = () => reject(req.error ?? new Error("Failed to read secure key"));
    tx.oncomplete = () => db.close();
    tx.onabort = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function secureSet(key: string, value: string): Promise<void> {
  const db = await openSecureStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECURE_STORE_NAME, "readwrite");
    const store = tx.objectStore(SECURE_STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("Failed to write secure key"));
    tx.oncomplete = () => db.close();
    tx.onabort = () => db.close();
    tx.onerror = () => db.close();
  });
}

function keyPairStoreKey(accountId: string) {
  return `${KEY_PREFIX}${accountId}`;
}

function peerStoreKey(accountId: string) {
  return `${PEER_PREFIX}${accountId}`;
}

function deviceStoreKey(accountId: string) {
  return `${DEVICE_PREFIX}${accountId}`;
}

function bundleStoreKey(accountId: string) {
  return `${BUNDLE_PREFIX}${accountId}`;
}

function bundleSecretStoreKey(accountId: string) {
  return `${BUNDLE_SECRET_PREFIX}${accountId}`;
}

function sessionStoreKey(accountId: string) {
  return `${SESSION_PREFIX}${accountId}`;
}

function sessionKey(peer: string, senderDeviceId: number) {
  return `${normalizeBareJid(peer)}:${senderDeviceId}`;
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function fromB64Buffer(b64: string): ArrayBuffer {
  return fromB64(b64).buffer as ArrayBuffer;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function ensureDeviceId(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const int = Math.trunc(value);
  return int > 0 ? int : undefined;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((p) => {
    out.set(p, offset);
    offset += p.length;
  });
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", asArrayBuffer(bytes));
  return new Uint8Array(digest);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey("raw", asArrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", hmacKey, asArrayBuffer(data));
  return new Uint8Array(sig);
}

function bundleSignaturePayload(bundle: Pick<OmemoBundle, "signedPreKeyPublic">): Uint8Array {
  return fromB64(bundle.signedPreKeyPublic);
}

async function signBundleSignature(identityPrivateJwk: JsonWebKey, bundle: Pick<OmemoBundle, "signedPreKeyPublic">): Promise<string> {
  const ecdsaJwk: JsonWebKey = {
    kty: identityPrivateJwk.kty,
    crv: identityPrivateJwk.crv,
    x: identityPrivateJwk.x,
    y: identityPrivateJwk.y,
    d: identityPrivateJwk.d,
    ext: true,
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    ecdsaJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    asArrayBuffer(bundleSignaturePayload(bundle))
  );
  return toB64(new Uint8Array(sig));
}

async function verifyBundleSignature(bundle: OmemoBundle): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromB64Buffer(bundle.identityKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromB64Buffer(bundle.signedPreKeySignature),
      asArrayBuffer(bundleSignaturePayload(bundle))
    );
  } catch {
    // continue to legacy compatibility check below
  }

  try {
    // Legacy compatibility: older LyaoTalk builds stored a SHA-256 digest string instead of a true signature.
    const legacyMaterial = new TextEncoder().encode(
      `${bundle.identityKey}.${bundle.signedPreKeyPublic}.${bundle.deviceId}`
    );
    const digest = await crypto.subtle.digest("SHA-256", legacyMaterial);
    const legacyB64 = toB64(new Uint8Array(digest));
    return legacyB64 === bundle.signedPreKeySignature;
  } catch {
    return false;
  }
}

async function nextChainKey(chain: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(chain, new TextEncoder().encode("next"));
}

async function wrapKeyFromChain(chain: Uint8Array, counter: number): Promise<Uint8Array> {
  return hmacSha256(chain, new TextEncoder().encode(`wrap:${counter}`));
}

function normalizePeerMap(raw: unknown): Record<string, PeerKeyInfo> {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const normalized: Record<string, PeerKeyInfo> = {};
  Object.entries(input).forEach(([jid, value]) => {
    if (typeof value === "string") {
      normalized[jid] = { publicRawB64: value };
      return;
    }
    if (!value || typeof value !== "object") return;
    const typed = value as { publicRawB64?: unknown; deviceId?: unknown; key?: unknown };
    const pub = typeof typed.publicRawB64 === "string"
      ? typed.publicRawB64
      : (typeof typed.key === "string" ? typed.key : "");
    if (!pub) return;
    normalized[jid] = { publicRawB64: pub, deviceId: ensureDeviceId(typed.deviceId) };
  });
  return normalized;
}

async function getPeerMap(accountId: string): Promise<Record<string, PeerKeyInfo>> {
  try {
    // Migrate from localStorage if needed
    const legacyRaw = localStorage.getItem(peerStoreKey(accountId));
    if (legacyRaw) {
      await secureSet(peerStoreKey(accountId), legacyRaw);
      localStorage.removeItem(peerStoreKey(accountId));
      return normalizePeerMap(JSON.parse(legacyRaw));
    }
    const raw = await secureGet(peerStoreKey(accountId));
    if (!raw) return {};
    return normalizePeerMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function setPeerMap(accountId: string, peers: Record<string, PeerKeyInfo>) {
  await secureSet(peerStoreKey(accountId), JSON.stringify(peers));
}

async function getBundleMap(accountId: string): Promise<Record<string, OmemoBundle>> {
  try {
    // Migrate from localStorage if needed
    const legacyRaw = localStorage.getItem(bundleStoreKey(accountId));
    if (legacyRaw) {
      await secureSet(bundleStoreKey(accountId), legacyRaw);
      localStorage.removeItem(bundleStoreKey(accountId));
      const parsed = JSON.parse(legacyRaw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, OmemoBundle> : {};
    }
    const raw = await secureGet(bundleStoreKey(accountId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, OmemoBundle> : {};
  } catch {
    return {};
  }
}

async function setBundleMap(accountId: string, bundles: Record<string, OmemoBundle>) {
  await secureSet(bundleStoreKey(accountId), JSON.stringify(bundles));
}

function parseObjectMap<T>(raw: string | null): Record<string, T> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, T>;
  } catch {
    return {};
  }
}

async function getBundleSecretMap(accountId: string): Promise<Record<string, LocalBundleSecret>> {
  const cached = bundleSecretCache.get(accountId);
  if (cached) return cached;
  const key = bundleSecretStoreKey(accountId);
  const secureRaw = await secureGet(key);
  if (secureRaw) {
    const parsed = parseObjectMap<LocalBundleSecret>(secureRaw);
    bundleSecretCache.set(accountId, parsed);
    return parsed;
  }
  const legacyRaw = localStorage.getItem(key);
  const parsed = parseObjectMap<LocalBundleSecret>(legacyRaw);
  await secureSet(key, JSON.stringify(parsed));
  localStorage.removeItem(key);
  bundleSecretCache.set(accountId, parsed);
  return parsed;
}

async function setBundleSecretMap(accountId: string, secrets: Record<string, LocalBundleSecret>) {
  bundleSecretCache.set(accountId, secrets);
  await secureSet(bundleSecretStoreKey(accountId), JSON.stringify(secrets));
}

async function getSessionMap(accountId: string): Promise<Record<string, SessionState>> {
  const cached = sessionCache.get(accountId);
  if (cached) return cached;
  const key = sessionStoreKey(accountId);
  const secureRaw = await secureGet(key);
  if (secureRaw) {
    const parsed = parseObjectMap<SessionState>(secureRaw);
    sessionCache.set(accountId, parsed);
    return parsed;
  }
  const legacyRaw = localStorage.getItem(key);
  const parsed = parseObjectMap<SessionState>(legacyRaw);
  await secureSet(key, JSON.stringify(parsed));
  localStorage.removeItem(key);
  sessionCache.set(accountId, parsed);
  return parsed;
}

async function setSessionMap(accountId: string, sessions: Record<string, SessionState>) {
  sessionCache.set(accountId, sessions);
  await secureSet(sessionStoreKey(accountId), JSON.stringify(sessions));
}

async function getPeerInfo(accountId: string, peerJid: string): Promise<PeerKeyInfo | null> {
  const normalizedPeer = normalizeBareJid(peerJid);
  const peers = await getPeerMap(accountId);
  return peers[normalizedPeer] ?? null;
}

async function getPeerBundles(accountId: string, peerJid: string): Promise<OmemoBundle[]> {
  const normalizedPeer = normalizeBareJid(peerJid);
  const bundles = await getBundleMap(accountId);
  return Object.entries(bundles)
    .filter(([k]) => k.startsWith(`${normalizedPeer}:`))
    .map(([, v]) => v);
}

async function getPeerBundleForDevice(accountId: string, peerJid: string, deviceId: number): Promise<OmemoBundle | null> {
  const normalizedPeer = normalizeBareJid(peerJid);
  const bundles = await getBundleMap(accountId);
  return bundles[`${normalizedPeer}:${deviceId}`] ?? null;
}

export function getOrCreateLocalDeviceId(accountId: string): number {
  const key = deviceStoreKey(accountId);
  const existing = ensureDeviceId(Number(localStorage.getItem(key)));
  if (existing) return existing;
  const random = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
  const created = Math.max(1, random);
  localStorage.setItem(key, String(created));
  return created;
}

export async function getOrCreateLocalKeyPair(accountId: string): Promise<StoredKeyPair> {
  const storeKey = keyPairStoreKey(accountId);
  const existing = await secureGet(storeKey) ?? localStorage.getItem(storeKey);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as StoredKeyPair;
      if (parsed?.privateJwk && parsed?.publicRawB64) {
        await secureSet(storeKey, JSON.stringify(parsed));
        localStorage.removeItem(storeKey);
        return parsed;
      }
    } catch {
      // regenerate
    }
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"]
  );
  const privateJwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const created: StoredKeyPair = { privateJwk, publicRawB64: toB64(publicRaw) };
  await secureSet(storeKey, JSON.stringify(created));
  localStorage.removeItem(storeKey);
  return created;
}

export async function getOrCreateLocalOmemoBundle(accountId: string): Promise<OmemoBundle> {
  const deviceId = getOrCreateLocalDeviceId(accountId);
  const map = await getBundleMap(accountId);
  const secretMap = await getBundleSecretMap(accountId);
  const existing = map[String(deviceId)];
  const existingSecret = secretMap[String(deviceId)];
  if (existing?.identityKey && existing?.signedPreKeyPublic && existing?.preKeys?.length && existingSecret?.signedPreKeyPrivateJwk) {
    const signatureValid = await verifyBundleSignature(existing);
    if (signatureValid) return existing;
    const identity = await getOrCreateLocalKeyPair(accountId);
    const resigned = {
      ...existing,
      signedPreKeySignature: await signBundleSignature(identity.privateJwk, existing),
    };
    map[String(deviceId)] = resigned;
    await setBundleMap(accountId, map);
    return resigned;
  }

  const identity = await getOrCreateLocalKeyPair(accountId);
  const signedPreKey = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"]
  );
  const signedPreKeyPublic = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", signedPreKey.publicKey)));
  const signedPreKeyPrivateJwk = (await crypto.subtle.exportKey("jwk", signedPreKey.privateKey)) as JsonWebKey;
  const preKeyPrivates: Record<string, JsonWebKey> = {};
  const preKeys = await Promise.all(Array.from({ length: 20 }).map(async (_, i) => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits", "deriveKey"]
    );
    preKeyPrivates[String(i + 1)] = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;
    return {
      preKeyId: i + 1,
      value: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))),
    };
  }));
  const bundle: OmemoBundle = {
    deviceId,
    signedPreKeyId: 1,
    signedPreKeyPublic,
    identityKey: identity.publicRawB64,
    preKeys,
    signedPreKeySignature: "",
  };
  bundle.signedPreKeySignature = await signBundleSignature(identity.privateJwk, bundle);
  map[String(deviceId)] = bundle;
  secretMap[String(deviceId)] = { signedPreKeyPrivateJwk, preKeyPrivates };
  await setBundleMap(accountId, map);
  await setBundleSecretMap(accountId, secretMap);
  return bundle;
}

async function importPrivateKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits", "deriveKey"]);
}

async function importPublicKey(rawB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64Buffer(rawB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function ecdhBits(privateJwk: JsonWebKey, publicRawB64: string): Promise<Uint8Array> {
  const privateKey = await importPrivateKey(privateJwk);
  const publicKey = await importPublicKey(publicRawB64);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );
  return new Uint8Array(bits);
}

async function deriveSessionKey(accountId: string, peerJid: string): Promise<CryptoKey | null> {
  const peer = await getPeerInfo(accountId, peerJid);
  if (!peer?.publicRawB64) return null;
  const local = await getOrCreateLocalKeyPair(accountId);
  const privateKey = await importPrivateKey(local.privateJwk);
  const publicKey = await importPublicKey(peer.publicRawB64);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function saveSession(accountId: string, session: SessionState) {
  const map = await getSessionMap(accountId);
  map[sessionKey(session.peer, session.senderDeviceId)] = session;
  await setSessionMap(accountId, map);
}

async function readSession(accountId: string, peerJid: string, senderDeviceId: number): Promise<SessionState | null> {
  const map = await getSessionMap(accountId);
  return map[sessionKey(peerJid, senderDeviceId)] ?? null;
}

function deriveInitialChains(root: Uint8Array, initiator: boolean) {
  const sendLabel = initiator ? "init-send" : "init-recv";
  const recvLabel = initiator ? "init-recv" : "init-send";
  return {
    sendLabel: new TextEncoder().encode(sendLabel),
    recvLabel: new TextEncoder().encode(recvLabel),
  };
}

async function initOutboundSession(
  accountId: string,
  peerJid: string,
  bundle: OmemoBundle
): Promise<{ session: SessionState; ek: string; pkid?: number } | null> {
  const peer = normalizeBareJid(peerJid);
  const identity = await getOrCreateLocalKeyPair(accountId);
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"]
  );
  const ephPriv = (await crypto.subtle.exportKey("jwk", eph.privateKey)) as JsonWebKey;
  const ephPub = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey)));
  const peerOneTime = bundle.preKeys[0];

  const dh1 = await ecdhBits(identity.privateJwk, bundle.signedPreKeyPublic);
  const dh2 = await ecdhBits(ephPriv, bundle.identityKey);
  const dh3 = await ecdhBits(ephPriv, bundle.signedPreKeyPublic);
  const pieces = [dh1, dh2, dh3];
  if (peerOneTime?.value) {
    const dh4 = await ecdhBits(ephPriv, peerOneTime.value);
    pieces.push(dh4);
  }
  const root = await sha256(concat(...pieces));
  const labels = deriveInitialChains(root, true);
  const sendChain = await hmacSha256(root, labels.sendLabel);
  const recvChain = await hmacSha256(root, labels.recvLabel);
  const session: SessionState = {
    peer,
    senderDeviceId: bundle.deviceId,
    rootKey: toB64(root),
    sendChain: toB64(sendChain),
    recvChain: toB64(recvChain),
    sendCounter: 0,
    recvCounter: 0,
  };
  await saveSession(accountId, session);
  return { session, ek: ephPub, pkid: peerOneTime?.preKeyId };
}

async function initInboundSession(
  accountId: string,
  peerJid: string,
  senderDeviceId: number,
  ek: string,
  pkid?: number
): Promise<SessionState | null> {
  const peer = normalizeBareJid(peerJid);
  const localDeviceId = getOrCreateLocalDeviceId(accountId);
  const localSecrets = (await getBundleSecretMap(accountId))[String(localDeviceId)];
  const localBundle = (await getBundleMap(accountId))[String(localDeviceId)];
  const peerBundle = await getPeerBundleForDevice(accountId, peer, senderDeviceId);
  const identity = await getOrCreateLocalKeyPair(accountId);
  if (!localSecrets?.signedPreKeyPrivateJwk || !localBundle?.identityKey || !peerBundle?.identityKey) return null;

  const dh1 = await ecdhBits(localSecrets.signedPreKeyPrivateJwk, peerBundle.identityKey);
  const dh2 = await ecdhBits(identity.privateJwk, ek);
  const dh3 = await ecdhBits(localSecrets.signedPreKeyPrivateJwk, ek);
  const pieces = [dh1, dh2, dh3];
  if (typeof pkid === "number" && localSecrets.preKeyPrivates[String(pkid)]) {
    const dh4 = await ecdhBits(localSecrets.preKeyPrivates[String(pkid)], ek);
    pieces.push(dh4);
  }
  const root = await sha256(concat(...pieces));
  const labels = deriveInitialChains(root, false);
  const sendChain = await hmacSha256(root, labels.sendLabel);
  const recvChain = await hmacSha256(root, labels.recvLabel);
  const session: SessionState = {
    peer,
    senderDeviceId,
    rootKey: toB64(root),
    sendChain: toB64(sendChain),
    recvChain: toB64(recvChain),
    sendCounter: 0,
    recvCounter: 0,
  };
  await saveSession(accountId, session);
  return session;
}

export async function buildKeyExchangePayload(accountId: string): Promise<string> {
  const local = await getOrCreateLocalKeyPair(accountId);
  const payload = {
    v: 2,
    deviceId: getOrCreateLocalDeviceId(accountId),
    pub: local.publicRawB64,
  };
  return `${KEY_EXCHANGE_PREFIX}${JSON.stringify(payload)}`;
}

export function parseKeyExchangePayload(body: string): KeyExchangeInfo | null {
  if (!body.startsWith(KEY_EXCHANGE_PREFIX)) return null;
  const raw = body.slice(KEY_EXCHANGE_PREFIX.length).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { pub?: unknown; deviceId?: unknown };
    if (typeof parsed.pub === "string" && parsed.pub) {
      return { publicRawB64: parsed.pub, deviceId: ensureDeviceId(parsed.deviceId) };
    }
  } catch {
    // backward compatibility
  }
  return { publicRawB64: raw };
}

export async function storePeerPublicKey(accountId: string, peerJid: string, info: string | KeyExchangeInfo) {
  const normalizedPeer = normalizeBareJid(peerJid);
  const peers = await getPeerMap(accountId);
  if (typeof info === "string") {
    peers[normalizedPeer] = { publicRawB64: info, deviceId: peers[normalizedPeer]?.deviceId };
  } else {
    peers[normalizedPeer] = {
      publicRawB64: info.publicRawB64,
      deviceId: info.deviceId ?? peers[normalizedPeer]?.deviceId,
    };
  }
  await setPeerMap(accountId, peers);
}

export async function storePeerOmemoBundle(accountId: string, peerJid: string, bundle: OmemoBundle): Promise<boolean> {
  const signatureValid = await verifyBundleSignature(bundle);
  if (!signatureValid) return false;
  const normalizedPeer = normalizeBareJid(peerJid);
  const map = await getBundleMap(accountId);
  map[`${normalizedPeer}:${bundle.deviceId}`] = bundle;
  await setBundleMap(accountId, map);
  storePeerPublicKey(accountId, normalizedPeer, {
    publicRawB64: bundle.signedPreKeyPublic || bundle.identityKey,
    deviceId: bundle.deviceId,
  });
  return true;
}

export async function encryptOmemoEnvelopeForPeer(
  accountId: string,
  peerJid: string,
  plainText: string
): Promise<{ envelope: OmemoEnvelope | null; usedPeerKey: boolean }> {
  const peerBundles = await getPeerBundles(accountId, peerJid);
  const peer = await getPeerInfo(accountId, peerJid);
  const targets: Array<{ rid: number; bundle?: OmemoBundle; fallbackPub?: string }> = [];
  peerBundles.forEach((bundle) => {
    targets.push({ rid: bundle.deviceId, bundle });
  });
  if (targets.length === 0 && peer?.publicRawB64) {
    targets.push({ rid: peer.deviceId ?? 1, fallbackPub: peer.publicRawB64 });
  }
  if (targets.length === 0) return { envelope: null, usedPeerKey: false };

  const localSid = getOrCreateLocalDeviceId(accountId);
  const messageKey = crypto.getRandomValues(new Uint8Array(32));
  const messageIv = crypto.getRandomValues(new Uint8Array(12));
  const payloadCipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: messageIv },
      await crypto.subtle.importKey("raw", messageKey, { name: "AES-GCM" }, false, ["encrypt"]),
      new TextEncoder().encode(plainText)
    )
  );

  const keys: OmemoEnvelopeKey[] = [];
  for (const target of targets) {
    let session = await readSession(accountId, peerJid, target.rid);
    let initMeta: { ek?: string; pkid?: number } = {};
    if (!session && target.bundle) {
      const initialized = await initOutboundSession(accountId, peerJid, target.bundle);
      if (initialized) {
        session = initialized.session;
        initMeta = { ek: initialized.ek, pkid: initialized.pkid };
      }
    }
    if (!session && target.fallbackPub) {
      const sessionKey = await deriveSessionKey(accountId, peerJid);
      if (!sessionKey) continue;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sessionKey, messageKey));
      keys.push({ rid: target.rid, value: toB64(concat(iv, wrapped)), prekey: true });
      continue;
    }
    if (!session) continue;

    const chain = fromB64(session.sendChain);
    const counter = session.sendCounter;
    const wrapKeyRaw = await wrapKeyFromChain(chain, counter);
    const wrapKey = await crypto.subtle.importKey("raw", asArrayBuffer(wrapKeyRaw), { name: "AES-GCM" }, false, ["encrypt"]);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, wrapKey, messageKey));
    keys.push({
      rid: target.rid,
      value: toB64(concat(wrapIv, wrapped)),
      prekey: true,
      n: counter,
      ek: initMeta.ek,
      pkid: initMeta.pkid,
    });
    const next = await nextChainKey(chain);
    session.sendChain = toB64(next);
    session.sendCounter = counter + 1;
    await saveSession(accountId, session);
  }

  if (keys.length === 0) return { envelope: null, usedPeerKey: false };
  return {
    usedPeerKey: true,
    envelope: {
      namespace: OMEMO_NAMESPACE,
      sid: localSid,
      iv: toB64(messageIv),
      keys,
      payload: toB64(payloadCipher),
    },
  };
}

export async function decryptOmemoEnvelopeFromPeer(
  accountId: string,
  peerJid: string,
  envelope: OmemoEnvelope
): Promise<string | null> {
  if (!OMEMO_SUPPORTED_NAMESPACES.includes(envelope.namespace as (typeof OMEMO_SUPPORTED_NAMESPACES)[number])) {
    return null;
  }
  const localRid = getOrCreateLocalDeviceId(accountId);
  const wrappedForMe = envelope.keys.find((k) => k.rid === localRid) ?? envelope.keys[0];
  if (!wrappedForMe?.value) return null;

  let session = await readSession(accountId, peerJid, envelope.sid);
  if (!session && wrappedForMe.ek) {
    session = await initInboundSession(accountId, peerJid, envelope.sid, wrappedForMe.ek, wrappedForMe.pkid);
  }
  if (!session) {
    const fallback = await deriveSessionKey(accountId, peerJid);
    if (!fallback) return null;
    try {
      const packed = fromB64(wrappedForMe.value);
      const iv = packed.slice(0, 12);
      const wrapped = packed.slice(12);
      const msgKeyRaw = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, fallback, wrapped);
      const msgKey = await crypto.subtle.importKey("raw", msgKeyRaw, { name: "AES-GCM" }, false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64Buffer(envelope.iv) },
        msgKey,
        fromB64Buffer(envelope.payload)
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }

  try {
    const packed = fromB64(wrappedForMe.value);
    if (packed.length <= 12) return null;
    const wrapIv = packed.slice(0, 12);
    const wrapped = packed.slice(12);
    const targetN = typeof wrappedForMe.n === "number" && wrappedForMe.n >= 0 ? wrappedForMe.n : session.recvCounter;
    let chain = fromB64(session.recvChain);
    while (session.recvCounter < targetN) {
      chain = await nextChainKey(chain);
      session.recvCounter += 1;
    }
    const wrapKeyRaw = await wrapKeyFromChain(chain, targetN);
    const wrapKey = await crypto.subtle.importKey("raw", asArrayBuffer(wrapKeyRaw), { name: "AES-GCM" }, false, ["decrypt"]);
    const messageKeyRaw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapIv }, wrapKey, wrapped);
    const msgKey = await crypto.subtle.importKey("raw", messageKeyRaw, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64Buffer(envelope.iv) },
      msgKey,
      fromB64Buffer(envelope.payload)
    );
    const next = await nextChainKey(chain);
    session.recvChain = toB64(next);
    session.recvCounter = targetN + 1;
    await saveSession(accountId, session);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function isEncryptedPayload(body: string): boolean {
  return body.trimStart().startsWith(CIPHER_PREFIX);
}

export async function decryptBodyFromPeer(
  accountId: string,
  peerJid: string,
  body: string
): Promise<string | null> {
  if (!isEncryptedPayload(body)) return body;
  const sessionKey = await deriveSessionKey(accountId, peerJid);
  if (!sessionKey) return null;
  try {
    const raw = body.slice(CIPHER_PREFIX.length);
    const parsed = JSON.parse(raw) as { iv: string; ct: string };
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64Buffer(parsed.iv) },
      sessionKey,
      fromB64Buffer(parsed.ct)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
