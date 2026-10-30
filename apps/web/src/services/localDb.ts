import Dexie, { Table } from "dexie";
import type { ChatMessage, Conversation } from "@/stores/chatStore";
import { useChatStore } from "@/stores/chatStore";
import { useRosterStore } from "@/stores/rosterStore";
import { generateConversationId } from "@/utils/helpers";

interface Draft {
  conversationId: string;
  body: string;
  updatedAt: number;
}

interface CachedContact {
  jid: string;
  accountId: string;
  name?: string;
  avatarUrl?: string;
  presence?: string;
  updatedAt: number;
}

interface CachedMessage extends ChatMessage {
  cacheKey: string;
}

interface LogoutVault {
  accountId: string;
  salt: Uint8Array;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

interface HistorySnapshot {
  accountId: string;
  conversations: Conversation[];
  messages: ChatMessage[];
}

class WGajimDB extends Dexie {
  messages!: Table<CachedMessage>;
  conversations!: Table<Conversation>;
  drafts!: Table<Draft>;
  contacts!: Table<CachedContact>;
  logoutVaults!: Table<LogoutVault, string>;

  constructor() {
    super("liaot");
    this.version(1).stores({
      messages: "id, conversationId, timestamp",
      conversations: "id, accountId, peerJid, lastMessageAt",
      drafts: "conversationId",
      contacts: "[jid+accountId], accountId",
    });
    this.version(2).stores({
      messages: "cacheKey, [conversationId+id], conversationId, timestamp, id",
      conversations: "id, accountId, peerJid, lastMessageAt",
      drafts: "conversationId",
      contacts: "[jid+accountId], accountId",
    });
    this.version(3).stores({
      messages: "cacheKey, [conversationId+id], conversationId, timestamp, id",
      conversations: "id, accountId, peerJid, lastMessageAt",
      drafts: "conversationId",
      contacts: "[jid+accountId], accountId",
      logoutVaults: "accountId",
    });
  }
}

export const db = new WGajimDB();

export function openLocalDb() {
  return db;
}

/** Preserve this device's contacts and conversations when a legacy local ID is replaced by the API ID. */
export async function migrateLocalAccountId(oldId: string, newId: string): Promise<void> {
  if (oldId === newId) return;
  const oldConversations = await db.conversations.where("accountId").equals(oldId).toArray();
  const oldContacts = await db.contacts.where("accountId").equals(oldId).toArray();
  const chat = useChatStore.getState();
  const allConversations = new Map<string, Conversation>();
  for (const conv of [...oldConversations, ...Object.values(chat.conversations)]) {
    if (conv.accountId === oldId) allConversations.set(conv.id, conv);
  }
  const idMap = new Map<string, string>();
  for (const conv of allConversations.values()) {
    idMap.set(conv.id, conv.type === "private" ? generateConversationId(newId, conv.peerJid) : conv.id.replace(`${oldId}:`, `${newId}:`));
  }
  await db.transaction("rw", db.conversations, db.messages, db.drafts, db.contacts, async () => {
    for (const conv of allConversations.values()) {
      const nextId = idMap.get(conv.id)!;
      if (!await db.conversations.get(nextId)) await db.conversations.put({ ...conv, id: nextId, accountId: newId });
      const messages = await db.messages.where("conversationId").equals(conv.id).toArray();
      for (const message of messages) {
        const cacheKey = `${nextId}:${message.id}`;
        if (!await db.messages.get(cacheKey)) await db.messages.put({ ...message, conversationId: nextId, cacheKey });
      }
      const draft = await db.drafts.get(conv.id);
      if (draft && !await db.drafts.get(nextId)) await db.drafts.put({ ...draft, conversationId: nextId });
    }
    for (const contact of oldContacts) {
      if (!await db.contacts.get([contact.jid, newId])) await db.contacts.put({ ...contact, accountId: newId });
    }
  });
  const roster = useRosterStore.getState().contacts;
  const contacts = { ...roster };
  for (const contact of Object.values(roster)) {
    if (contact.accountId !== oldId) continue;
    const key = `${newId}::${contact.jid}`;
    if (!contacts[key]) contacts[key] = { ...contact, accountId: newId };
  }
  useRosterStore.setState({ contacts });
  const rekey = <T,>(values: Record<string, T>, separator = "") => {
    const next = { ...values };
    for (const [oldConvId, newConvId] of idMap) {
      for (const [key, value] of Object.entries(values)) {
        if (key !== oldConvId && !(separator && key.startsWith(`${oldConvId}${separator}`))) continue;
        const newKey = newConvId + key.slice(oldConvId.length);
        if (!(newKey in next)) next[newKey] = value;
      }
    }
    return next;
  };
  const conversations = { ...chat.conversations };
  for (const conv of allConversations.values()) {
    const nextId = idMap.get(conv.id)!;
    if (!conversations[nextId]) conversations[nextId] = { ...conv, id: nextId, accountId: newId };
  }
  const messages = rekey(chat.messages);
  for (const [oldConvId, newConvId] of idMap) {
    if (messages[newConvId]) messages[newConvId] = messages[newConvId].map((message) => ({ ...message, conversationId: newConvId }));
  }
  useChatStore.setState({
    conversations,
    messages,
    composerDrafts: rekey(chat.composerDrafts),
    clearedBefore: rekey(chat.clearedBefore),
    retractedMessageIds: rekey(chat.retractedMessageIds, "\u0000"),
    locallyDeletedMessageIds: rekey(chat.locallyDeletedMessageIds, "\u0000"),
    pendingRetractions: rekey(chat.pendingRetractions, "\u0000"),
    activeConversationId: chat.activeConversationId ? idMap.get(chat.activeConversationId) ?? chat.activeConversationId : null,
  });
}

// Helper functions
export async function cacheMessages(messages: ChatMessage[]) {
  const state = useChatStore.getState();
  const cutoffs = state.clearedBefore ?? {};
  const rows: CachedMessage[] = messages.filter((m) => m.timestamp > (cutoffs[m.conversationId] ?? 0)
    && !state.locallyDeletedMessageIds?.[`${m.conversationId}\u0000${m.id}`]).map((m) => {
    const retractedAt = state.retractedMessageIds?.[`${m.conversationId}\u0000${m.id}`];
    return {
      ...m,
      ...(retractedAt ? { body: "", deletedAt: retractedAt, attachments: [], cipherPayload: undefined, omemoEnvelope: undefined } : {}),
      cacheKey: `${m.conversationId}:${m.id}`,
    };
  });
  await db.messages.bulkPut(rows);
}

export async function getLocalMessages(conversationId: string, limit = 50) {
  const cutoff = useChatStore.getState().clearedBefore?.[conversationId] ?? 0;
  const rows = await db.messages
    .where("conversationId")
    .equals(conversationId)
    .reverse()
    .limit(limit)
    .toArray();
  return rows
    .filter((msg) => msg.timestamp > cutoff
      && !useChatStore.getState().locallyDeletedMessageIds?.[`${msg.conversationId}\u0000${msg.id}`])
    .map(({ cacheKey: _cacheKey, ...msg }) => {
      const retractedAt = useChatStore.getState().retractedMessageIds?.[`${msg.conversationId}\u0000${msg.id}`];
      return retractedAt ? { ...msg, body: "", deletedAt: retractedAt, attachments: [], cipherPayload: undefined, omemoEnvelope: undefined } : msg;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function deleteLocalMessage(conversationId: string, messageId: string) {
  await db.messages.delete(`${conversationId}:${messageId}`);
}

export async function saveDraft(conversationId: string, body: string) {
  if (body.trim()) {
    await db.drafts.put({ conversationId, body, updatedAt: Date.now() });
  } else {
    await db.drafts.delete(conversationId);
  }
}

export async function getDraft(conversationId: string): Promise<string> {
  const d = await db.drafts.get(conversationId);
  return d?.body ?? "";
}

export async function cacheConversations(convs: Conversation[]) {
  await db.conversations.bulkPut(convs);
}

export async function getLocalConversations(accountId: string) {
  return db.conversations
    .where("accountId")
    .equals(accountId)
    .reverse()
    .sortBy("lastMessageAt");
}

export async function clearLocalMessageHistory() {
  await db.messages.clear();
}

export async function pruneLocalMessagesBefore(cutoffTs: number) {
  await db.messages.where("timestamp").below(cutoffTs).delete();
}

export async function deleteLocalConversationData(conversationId: string) {
  await db.messages.where("conversationId").equals(conversationId).delete();
  await db.drafts.delete(conversationId);
  await db.conversations.delete(conversationId);
}

export async function clearLocalAccountData(accountId: string) {
  const convs = await db.conversations.where("accountId").equals(accountId).toArray();
  const convIds = [...new Set([
    ...convs.map((c) => c.id),
    ...Object.values(useChatStore.getState().conversations)
      .filter((conv) => conv.accountId === accountId).map((conv) => conv.id),
  ])];
  if (convIds.length > 0) {
    await Promise.all(convIds.map((id) => db.messages.where("conversationId").equals(id).delete()));
    await Promise.all(convIds.map((id) => db.drafts.delete(id)));
  }
  await db.conversations.where("accountId").equals(accountId).delete();
  await db.contacts.where("accountId").equals(accountId).delete();
}

async function historyKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 210_000, hash: "SHA-256" },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

/** Keep replayable plaintext only in a password-encrypted vault while signed out. */
export async function sealLocalAccountHistory(accountId: string, password: string): Promise<void> {
  const state = useChatStore.getState();
  const cachedConversations = await db.conversations.where("accountId").equals(accountId).toArray();
  const conversations = [...new Map([
    ...cachedConversations,
    ...Object.values(state.conversations).filter((conv) => conv.accountId === accountId),
  ].map((conv) => [conv.id, conv])).values()];
  const convIds = new Set(conversations.map((conv) => conv.id));
  const cached = convIds.size ? await db.messages.where("conversationId").anyOf([...convIds]).toArray() : [];
  const byId = new Map<string, ChatMessage>();
  for (const message of cached) byId.set(`${message.conversationId}\0${message.id}`, message);
  for (const convId of convIds) {
    for (const message of state.messages[convId] ?? []) byId.set(`${convId}\0${message.id}`, message);
  }
  const messages = [...byId.values()].filter((message) =>
    message.timestamp > (state.clearedBefore[message.conversationId] ?? 0)
    && !state.locallyDeletedMessageIds[`${message.conversationId}\0${message.id}`]
  ).map(({ cipherPayload: _cipherPayload, omemoEnvelope: _omemoEnvelope, ...message }) => message);
  const snapshot: HistorySnapshot = { accountId, conversations, messages };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await historyKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(JSON.stringify(snapshot)),
  );
  await db.logoutVaults.put({ accountId, salt, iv, ciphertext });
}

/** Restore a prior same-browser session only after the account password was verified. */
export async function restoreLocalAccountHistory(accountId: string, password: string): Promise<boolean> {
  const vault = await db.logoutVaults.get(accountId);
  if (!vault) return false;
  const key = await historyKey(password, vault.salt);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: vault.iv as BufferSource }, key, vault.ciphertext);
  const snapshot = JSON.parse(new TextDecoder().decode(plaintext)) as HistorySnapshot;
  if (snapshot.accountId !== accountId || !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.messages)) {
    throw new Error("Invalid local history vault");
  }
  const conversations = snapshot.conversations.filter((conv) => conv.accountId === accountId);
  const convIds = new Set(conversations.map((conv) => conv.id));
  const messages = snapshot.messages.filter((message) => convIds.has(message.conversationId));
  await db.transaction("rw", db.conversations, db.messages, db.logoutVaults, async () => {
    await db.conversations.bulkPut(conversations);
    await db.messages.bulkPut(messages.map((message) => ({ ...message, cacheKey: `${message.conversationId}:${message.id}` })));
    await db.logoutVaults.delete(accountId);
  });
  useChatStore.setState((state) => {
    const nextConversations = { ...state.conversations };
    const nextMessages = { ...state.messages };
    for (const conv of conversations) {
      nextConversations[conv.id] = conv;
      const previous = nextMessages[conv.id] ?? [];
      const byMessageId = new Map(previous.map((message) => [message.id, message]));
      for (const message of messages.filter((item) => item.conversationId === conv.id)) {
        if (!byMessageId.has(message.id)) byMessageId.set(message.id, message);
      }
      nextMessages[conv.id] = [...byMessageId.values()].sort((a, b) => a.timestamp - b.timestamp);
    }
    return { conversations: nextConversations, messages: nextMessages };
  });
  return true;
}
