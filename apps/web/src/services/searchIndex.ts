/**
 * searchIndex.ts - Local full-text search index using MiniSearch.
 *
 * Why client-side instead of server-side?
 *   - Privacy: search queries never leave the device
 *   - Offline: works when XMPP/API is unreachable
 *   - Speed: instant results, no network round-trip
 *
 * The index is rebuilt incrementally as new messages arrive,
 * persisted to IndexedDB on save.
 */

import MiniSearch from "minisearch";
import { useChatStore, ChatMessage } from "@/stores/chatStore";
import { openLocalDb } from "@/services/localDb";

const DB_NAME = "liaot-search-index";
const STORE_NAME = "search_index_blobs";

let _index: MiniSearch | null = null;
let _initialized = false;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

interface IndexedMessage {
  id: string;
  conversationId: string;
  senderJid: string;
  body: string;
  timestamp: number;
}

function newIndex(): MiniSearch {
  return new MiniSearch({
    fields: ["body", "senderJid"],
    storeFields: ["id", "conversationId", "senderJid", "body", "timestamp"],
    searchOptions: {
      boost: { body: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
}

async function loadIndexFromIdb(accountId: string): Promise<MiniSearch | null> {
  try {
    const db = await openIndexDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(accountId);
      req.onsuccess = () => {
        if (!req.result) {
          resolve(null);
          return;
        }
        try {
          resolve(MiniSearch.loadJSON(req.result, {
            fields: ["body", "senderJid"],
            storeFields: ["id", "conversationId", "senderJid", "body", "timestamp"],
          }));
        } catch {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveIndexToIdb(accountId: string, index: MiniSearch): Promise<void> {
  try {
    const db = await openIndexDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(JSON.stringify(index), accountId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* ignore */ }
}

function openIndexDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Build initial index from chatStore messages.
 * Called once on app startup.
 */
export async function initSearchIndex(accountId: string): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Try loading from IndexedDB first
  const persisted = await loadIndexFromIdb(accountId);
  if (persisted) {
    _index = persisted;
    // A retraction tombstone may have persisted after the index's last save.
    const tombstones = useChatStore.getState().retractedMessageIds ?? {};
    for (const key of Object.keys(tombstones)) {
      const split = key.indexOf("\u0000");
      if (split < 0) continue;
      try { _index.remove({ id: `${key.slice(0, split)}:${key.slice(split + 1)}` } as any); }
      catch { /* already absent */ }
    }
    if (Object.keys(tombstones).length) scheduleSave(accountId);
    return;
  }

  // Fresh build from chatStore
  _index = newIndex();
  const allMessages = useChatStore.getState().messages;
  const conversations = useChatStore.getState().conversations;
  const accountConvIds = new Set(
    Object.values(conversations).filter((c) => c.accountId === accountId).map((c) => c.id)
  );

  for (const [convId, msgs] of Object.entries(allMessages)) {
    if (!accountConvIds.has(convId)) continue;
    for (const msg of msgs) {
      if (!msg.body) continue;
      _index.add({
        id: `${convId}:${msg.id}`,  // composite key avoids collisions
        conversationId: convId,
        senderJid: msg.senderJid,
        body: msg.body,
        timestamp: msg.timestamp,
      });
    }
  }
  scheduleSave(accountId);
}

/**
 * Add a new message to the index. Call from xmppBridge on every message.received.
 */
export function indexMessage(accountId: string, conversationId: string, msg: ChatMessage): void {
  if (!_index || !msg.body) return;
  const docId = `${conversationId}:${msg.id}`;
  try {
    _index.add({
      id: docId,
      conversationId,
      senderJid: msg.senderJid,
      body: msg.body,
      timestamp: msg.timestamp,
    });
    scheduleSave(accountId);
  } catch {
    // Duplicate id - already indexed
  }
}

/**
 * Remove a message from the index (e.g. when retracted or conversation deleted).
 */
export function removeFromIndex(conversationId: string, messageId: string, accountId?: string): void {
  if (!_index) return;
  try {
    _index.remove({ id: `${conversationId}:${messageId}` } as any);
    if (accountId) scheduleSave(accountId);
  } catch { /* ignore */ }
}

function scheduleSave(accountId: string): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (_index) saveIndexToIdb(accountId, _index);
  }, 5000); // batch saves every 5s
}

/**
 * Search the local index. Returns results sorted by relevance.
 */
export function searchLocal(query: string, limit: number = 50): IndexedMessage[] {
  if (!_index || !query.trim()) return [];
  const results = _index.search(query, { combineWith: "AND", prefix: true, fuzzy: 0.2 });
  return results.slice(0, limit).map((r) => ({
    id: String(r.id).split(":").slice(1).join(":"),
    conversationId: r.conversationId,
    senderJid: r.senderJid,
    body: r.body,
    timestamp: r.timestamp,
  }));
}
