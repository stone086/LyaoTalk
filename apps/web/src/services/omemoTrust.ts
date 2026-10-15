import { normalizeBareJid } from "@/utils/helpers";
import type { OmemoDeviceFingerprint } from "@/services/omemoFingerprint";

export type DeviceTrustState = "unverified" | "verified" | "untrusted" | "blind_trust";

export interface DeviceRecord {
  jid: string;
  deviceId: number;
  fingerprint: string;
  trustState: DeviceTrustState;
  firstSeen: number;
  lastSeen: number;
  keyChanged?: boolean;
  previousFingerprint?: string;
}

const TRUST_PREFIX = "liaot-omemo-trust:";
const TRUST_DB_NAME = "liaot-omemo-trust";
const TRUST_DB_VERSION = 1;
const TRUST_STORE_NAME = "devices";

interface TrustRecord {
  fingerprint: string;
  trusted: boolean;
  verifiedAt?: number;
  trustState?: DeviceTrustState;
  firstSeen?: number;
  lastSeen?: number;
  keyChanged?: boolean;
  previousFingerprint?: string;
}

type TrustMap = Record<string, TrustRecord>;

function key(accountId: string) {
  return `${TRUST_PREFIX}${accountId}`;
}

function id(peerJid: string, deviceId: number) {
  return `${normalizeBareJid(peerJid)}:${deviceId}`;
}

function recordKey(accountId: string, peerJid: string, deviceId: number) {
  return `${accountId}:${id(peerJid, deviceId)}`;
}

function now() {
  return Date.now();
}

function normalizeState(record: TrustRecord | undefined): DeviceTrustState {
  if (!record) return "unverified";
  if (record.trustState) return record.trustState;
  return record.trusted ? "verified" : "untrusted";
}

function load(accountId: string): TrustMap {
  try {
    const raw = localStorage.getItem(key(accountId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as TrustMap : {};
  } catch {
    return {};
  }
}

function save(accountId: string, map: TrustMap) {
  localStorage.setItem(key(accountId), JSON.stringify(map));
}

function openTrustDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TRUST_DB_NAME, TRUST_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRUST_STORE_NAME)) {
        db.createObjectStore(TRUST_STORE_NAME, { keyPath: "storageKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open OMEMO trust database"));
  });
}

async function idbPut(accountId: string, record: DeviceRecord): Promise<void> {
  const db = await openTrustDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRUST_STORE_NAME, "readwrite");
    tx.objectStore(TRUST_STORE_NAME).put({
      storageKey: recordKey(accountId, record.jid, record.deviceId),
      accountId,
      ...record,
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      const err = tx.error ?? new Error("Failed to save OMEMO trust record");
      db.close();
      reject(err);
    };
    tx.onabort = tx.onerror;
  });
}

async function idbGet(accountId: string, peerJid: string, deviceId: number): Promise<DeviceRecord | null> {
  const db = await openTrustDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(TRUST_STORE_NAME, "readonly")
      .objectStore(TRUST_STORE_NAME)
      .get(recordKey(accountId, peerJid, deviceId));
    req.onsuccess = () => {
      db.close();
      const row = req.result as (DeviceRecord & { storageKey?: string; accountId?: string }) | undefined;
      if (!row) return resolve(null);
      const { storageKey: _storageKey, accountId: _accountId, ...record } = row;
      resolve(record);
    };
    req.onerror = () => {
      const err = req.error ?? new Error("Failed to read OMEMO trust record");
      db.close();
      reject(err);
    };
  });
}

export async function listPeerDeviceTrustRecords(accountId: string, peerJid: string): Promise<DeviceRecord[]> {
  const peer = normalizeBareJid(peerJid);
  const records: DeviceRecord[] = [];
  try {
    const db = await openTrustDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(TRUST_STORE_NAME, "readonly").objectStore(TRUST_STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const row = cursor.value as DeviceRecord & { storageKey?: string; accountId?: string };
        if (row.accountId === accountId && normalizeBareJid(row.jid) === peer) {
          const { storageKey: _storageKey, accountId: _accountId, ...record } = row;
          records.push(record);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("Failed to list OMEMO trust records"));
    });
    db.close();
  } catch {
    // Fall back to legacy localStorage below.
  }

  const map = load(accountId);
  Object.entries(map).forEach(([legacyId, value]) => {
    const [jidPart, devicePart] = legacyId.split(":");
    const deviceId = Number(devicePart);
    if (!Number.isFinite(deviceId) || normalizeBareJid(jidPart) !== peer) return;
    if (records.some((item) => item.deviceId === deviceId)) return;
    records.push({
      jid: peer,
      deviceId,
      fingerprint: value.fingerprint,
      trustState: normalizeState(value),
      firstSeen: value.firstSeen ?? value.verifiedAt ?? now(),
      lastSeen: value.lastSeen ?? value.verifiedAt ?? now(),
      keyChanged: value.keyChanged,
      previousFingerprint: value.previousFingerprint,
    });
  });

  return records.sort((a, b) => a.deviceId - b.deviceId);
}

export async function upsertPeerDeviceTrustRecord(
  accountId: string,
  peerJid: string,
  deviceId: number,
  fingerprint: string,
  trustState: DeviceTrustState = "blind_trust"
): Promise<{ record: DeviceRecord; keyChanged: boolean }> {
  const peer = normalizeBareJid(peerJid);
  const timestamp = now();
  const existing = await idbGet(accountId, peer, deviceId).catch(() => null);
  const legacy = load(accountId)[id(peer, deviceId)];
  const previous = existing ?? (legacy ? {
    jid: peer,
    deviceId,
    fingerprint: legacy.fingerprint,
    trustState: normalizeState(legacy),
    firstSeen: legacy.firstSeen ?? legacy.verifiedAt ?? timestamp,
    lastSeen: legacy.lastSeen ?? legacy.verifiedAt ?? timestamp,
    keyChanged: legacy.keyChanged,
    previousFingerprint: legacy.previousFingerprint,
  } satisfies DeviceRecord : null);

  const keyChanged = Boolean(previous && previous.fingerprint && previous.fingerprint !== fingerprint);
  const record: DeviceRecord = {
    jid: peer,
    deviceId,
    fingerprint,
    trustState: keyChanged ? "unverified" : (previous?.trustState ?? trustState),
    firstSeen: previous?.firstSeen ?? timestamp,
    lastSeen: timestamp,
    keyChanged,
    previousFingerprint: keyChanged ? previous?.fingerprint : previous?.previousFingerprint,
  };

  await idbPut(accountId, record).catch(() => undefined);

  const map = load(accountId);
  map[id(peer, deviceId)] = {
    fingerprint: record.fingerprint,
    trusted: record.trustState === "verified" || record.trustState === "blind_trust",
    verifiedAt: record.trustState === "verified" ? timestamp : undefined,
    trustState: record.trustState,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    keyChanged: record.keyChanged,
    previousFingerprint: record.previousFingerprint,
  };
  save(accountId, map);

  return { record, keyChanged };
}

export async function updatePeerDeviceTrustState(
  accountId: string,
  peerJid: string,
  deviceId: number,
  trustState: DeviceTrustState
): Promise<DeviceRecord | null> {
  const peer = normalizeBareJid(peerJid);
  const existing = await idbGet(accountId, peer, deviceId).catch(() => null);
  const legacy = load(accountId)[id(peer, deviceId)];
  const base = existing ?? (legacy ? {
    jid: peer,
    deviceId,
    fingerprint: legacy.fingerprint,
    trustState: normalizeState(legacy),
    firstSeen: legacy.firstSeen ?? legacy.verifiedAt ?? now(),
    lastSeen: legacy.lastSeen ?? legacy.verifiedAt ?? now(),
    keyChanged: legacy.keyChanged,
    previousFingerprint: legacy.previousFingerprint,
  } satisfies DeviceRecord : null);
  if (!base) return null;
  const record: DeviceRecord = {
    ...base,
    trustState,
    lastSeen: now(),
    keyChanged: trustState === "verified" ? false : base.keyChanged,
  };
  await idbPut(accountId, record).catch(() => undefined);
  setPeerDeviceTrust(accountId, peer, deviceId, record.fingerprint, trustState === "verified" || trustState === "blind_trust");
  const map = load(accountId);
  if (map[id(peer, deviceId)]) {
    map[id(peer, deviceId)].trustState = trustState;
    map[id(peer, deviceId)].keyChanged = record.keyChanged;
    map[id(peer, deviceId)].lastSeen = record.lastSeen;
    save(accountId, map);
  }
  return record;
}

export function setPeerDeviceTrust(
  accountId: string,
  peerJid: string,
  deviceId: number,
  fingerprint: string,
  trusted: boolean
) {
  const map = load(accountId);
  const legacyKey = id(peerJid, deviceId);
  const existing = map[legacyKey];
  const keyChanged = Boolean(existing?.fingerprint && existing.fingerprint !== fingerprint);
  map[legacyKey] = {
    fingerprint,
    trusted,
    verifiedAt: trusted ? now() : undefined,
    trustState: trusted ? "verified" : "untrusted",
    firstSeen: existing?.firstSeen ?? existing?.verifiedAt ?? now(),
    lastSeen: now(),
    keyChanged,
    previousFingerprint: keyChanged ? existing?.fingerprint : existing?.previousFingerprint,
  };
  save(accountId, map);
}

export function isPeerDeviceTrusted(
  accountId: string,
  peerJid: string,
  deviceId: number,
  fingerprint: string
): boolean {
  const map = load(accountId);
  const record = map[id(peerJid, deviceId)];
  if (!record) return false;
  if (record.fingerprint !== fingerprint) return false;
  const state = normalizeState(record);
  return state === "verified" || state === "blind_trust";
}

export function getUntrustedPeerDevices(
  accountId: string,
  peerJid: string,
  devices: OmemoDeviceFingerprint[]
): OmemoDeviceFingerprint[] {
  return devices.filter((item) => !isPeerDeviceTrusted(accountId, peerJid, item.deviceId, item.fingerprint));
}
