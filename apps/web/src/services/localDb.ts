import Dexie, { Table } from "dexie";
import type { ChatMessage, Conversation } from "@/stores/chatStore";
import { useChatStore } from "@/stores/chatStore";

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

class WGajimDB extends Dexie {
  messages!: Table<CachedMessage>;
  conversations!: Table<Conversation>;
  drafts!: Table<Draft>;
  contacts!: Table<CachedContact>;

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
  }
}

export const db = new WGajimDB();

export function openLocalDb() {
  return db;
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
  const convIds = convs.map((c) => c.id);
  if (convIds.length > 0) {
    await Promise.all(convIds.map((id) => db.messages.where("conversationId").equals(id).delete()));
    await Promise.all(convIds.map((id) => db.drafts.delete(id)));
  }
  await db.conversations.where("accountId").equals(accountId).delete();
  await db.contacts.where("accountId").equals(accountId).delete();
}
