/**
 * credentialVault - at-rest protection for the XMPP account password.
 *
 * The password has to survive a page reload, because reconnecting XMPP after a
 * refresh still authenticates with it. Keeping it as a plain string in
 * sessionStorage meant that anything able to read the profile - a crash dump, a
 * sync'd copy, or a same-origin script iterating storage - walked away with a
 * long-lived credential.
 *
 * Here it is sealed with AES-GCM under a non-extractable CryptoKey that lives
 * in IndexedDB. The key material is never exposed to JavaScript, so storage
 * dumps no longer contain the password.
 *
 * Residual risk, deliberately documented rather than papered over: same-origin
 * JavaScript can ask the browser to decrypt while the tab is open, so an XSS
 * can still recover the plaintext at runtime. Closing that requires replacing
 * password auth with a token-based XMPP credential (SASL EXTERNAL / SASL2).
 */

const DB_NAME = "liaot-credential-vault";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const CRED_STORE = "credentials";
const KEY_ID = "aes-gcm";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(CRED_STORE)) db.createObjectStore(CRED_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOrCreateKey(db: IDBDatabase): Promise<CryptoKey> {
  const store = db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE);
  const existing = await reqToPromise<CryptoKey | undefined>(store.get(KEY_ID));
  if (existing) return existing;
  // extractable:false - the raw bytes never reach JS, so the key cannot be
  // exfiltrated alongside the ciphertext it protects.
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const tx = db.transaction(KEY_STORE, "readwrite");
  tx.objectStore(KEY_STORE).put(key, KEY_ID);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  return key;
}

export async function sealCredential(accountId: string, password: string): Promise<void> {
  if (!accountId || !password) return;
  const db = await openDb();
  const key = await getOrCreateKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(password)
  );
  const tx = db.transaction(CRED_STORE, "readwrite");
  tx.objectStore(CRED_STORE).put({ v: 1, iv: iv.buffer, ct: sealed }, accountId);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function openCredential(accountId: string): Promise<string | null> {
  if (!accountId) return null;
  const db = await openDb();
  const record = await reqToPromise<
    { v: number; iv: ArrayBuffer; ct: ArrayBuffer } | undefined
  >(db.transaction(CRED_STORE, "readonly").objectStore(CRED_STORE).get(accountId));
  if (!record?.ct) return null;
  const key = await getOrCreateKey(db);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv },
      key,
      record.ct
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Key rotated or ciphertext damaged - fall back to a manual login.
    return null;
  }
}

export async function clearCredential(accountId: string): Promise<void> {
  if (!accountId) return;
  const db = await openDb();
  const tx = db.transaction(CRED_STORE, "readwrite");
  tx.objectStore(CRED_STORE).delete(accountId);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
