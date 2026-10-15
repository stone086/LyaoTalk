/**
 * omemo/store.ts - IndexedDB-backed key store for libsignal-protocol-typescript.
 *
 * libsignal needs a SignalProtocolStore implementation with these operations:
 *   - getIdentityKeyPair / getLocalRegistrationId
 *   - load/store/remove/listSessions (session state per peer)
 *   - load/store/remove preKeys (one-time, used in handshake)
 *   - load/store/remove signedPreKeys (medium-term, signed by identity)
 *   - load/store/remove identityKeys per peer (trust-on-first-use)
 *
 * We keep them all in IndexedDB for security and capacity.
 * Each account has its own logical store, namespaced by accountId.
 */
import {
  KeyPairType,
  SignedPublicPreKeyType,
  PreKeyType,
  Direction,
  StorageType,
} from "@privacyresearch/libsignal-protocol-typescript";

const DB_NAME = "liaot-omemo";
const DB_VERSION = 1;
const STORE = "omemo_keys";

let _db: IDBDatabase | null = null;

async function getDb(): Promise<IDBDatabase> {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbGet<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut<T>(key: string, value: T): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDel(key: string): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * SignalProtocolStore implementation backed by IndexedDB.
 * One instance per local XMPP account.
 */
export class OmemoStore implements StorageType {
  constructor(private accountId: string) {}

  private k(key: string): string {
    return `${this.accountId}:${key}`;
  }

  // Identity ----------------------------------------------------
  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    return dbGet<KeyPairType>(this.k("identityKey"));
  }
  async getLocalRegistrationId(): Promise<number | undefined> {
    return dbGet<number>(this.k("registrationId"));
  }
  async storeIdentity(keyPair: KeyPairType, registrationId: number) {
    await dbPut(this.k("identityKey"), keyPair);
    await dbPut(this.k("registrationId"), registrationId);
  }

  // Trust per peer (TOFU) --------------------------------------
  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    _direction?: Direction
  ): Promise<boolean> {
    const trusted = await dbGet<ArrayBuffer>(this.k(`identity:${identifier}`));
    if (!trusted) return true; // first contact = trust on first use
    return arrayBufferEqual(trusted, identityKey);
  }
  async loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined> {
    return dbGet<ArrayBuffer>(this.k(`identity:${identifier}`));
  }
  async saveIdentity(identifier: string, identityKey: ArrayBuffer): Promise<boolean> {
    const existing = await dbGet<ArrayBuffer>(this.k(`identity:${identifier}`));
    await dbPut(this.k(`identity:${identifier}`), identityKey);
    return existing ? !arrayBufferEqual(existing, identityKey) : false;
  }

  // PreKeys -----------------------------------------------------
  async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    return dbGet<KeyPairType>(this.k(`preKey:${keyId}`));
  }
  async storePreKey(keyId: string | number, keyPair: KeyPairType) {
    await dbPut(this.k(`preKey:${keyId}`), keyPair);
  }
  async removePreKey(keyId: string | number) {
    await dbDel(this.k(`preKey:${keyId}`));
  }

  // SignedPreKey ------------------------------------------------
  async loadSignedPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    return dbGet<KeyPairType>(this.k(`signedPreKey:${keyId}`));
  }
  async storeSignedPreKey(keyId: string | number, keyPair: KeyPairType) {
    await dbPut(this.k(`signedPreKey:${keyId}`), keyPair);
  }
  async removeSignedPreKey(keyId: string | number) {
    await dbDel(this.k(`signedPreKey:${keyId}`));
  }

  // Sessions ----------------------------------------------------
  async loadSession(identifier: string): Promise<string | undefined> {
    return dbGet<string>(this.k(`session:${identifier}`));
  }
  async storeSession(identifier: string, record: string) {
    await dbPut(this.k(`session:${identifier}`), record);
  }
  async removeSession(identifier: string) {
    await dbDel(this.k(`session:${identifier}`));
  }
  async removeAllSessions(identifier: string) {
    // identifier is a JID; sessions are keyed by JID.deviceId
    // Without an index we'd need to iterate, but for now removeSession is enough
    await this.removeSession(identifier);
  }
}

function arrayBufferEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

export type { SignedPublicPreKeyType, PreKeyType };
