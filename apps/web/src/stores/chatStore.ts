import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateConversationId, isValidBareJid, normalizeBareJid } from "@/utils/helpers";
import type { OmemoEnvelope } from "@/services/xmppAdapter";

export type MessageDirection = "in" | "out" | "system";
export type ConversationType = "private" | "group" | "system";

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderJid: string;
  body: string;
  bodyType: "text" | "html" | "markdown";
  direction: MessageDirection;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  timestamp: number;
  editedAt?: number;
  deletedAt?: number;
  starred?: boolean;
  reactions?: Record<string, number>;
  encrypted?: boolean;
  decryptFailed?: boolean;
  cipherPayload?: string;
  omemoEnvelope?: OmemoEnvelope;
  replyToId?: string;
  attachments?: MessageAttachment[];
  /** MUC-assigned XEP-0359 id, used when retracting a group message. */
  stanzaId?: string;
  /** Full room/nickname JID, used to verify group retraction authorship. */
  occupantJid?: string;
}

export interface MessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  downloadUrl: string;
  sizeBytes: number;
}

export interface Conversation {
  id: string;
  accountId: string;
  type: ConversationType;
  peerJid: string;
  title: string;
  avatarUrl?: string;
  lastMessage?: string;
  lastMessageAt?: number;
  unreadCount: number;
  pinned: boolean;
}

export interface PendingRetraction {
  from: string;
  realSenderJid?: string;
  type: "chat" | "groupchat";
  at: number;
}

export function retractionMatchesMessage(message: ChatMessage, request: PendingRetraction): boolean {
  if (request.type === "groupchat") {
    return Boolean(message.occupantJid && message.occupantJid === request.from)
      || Boolean(request.realSenderJid && normalizeBareJid(message.senderJid) === normalizeBareJid(request.realSenderJid));
  }
  return normalizeBareJid(message.senderJid) === normalizeBareJid(request.from);
}

interface ChatState {
  conversations: Record<string, Conversation>;
  messages: Record<string, ChatMessage[]>; // keyed by conversationId
  composerDrafts: Record<string, string>;
  typingPeers: Record<string, string | null>;
  clearedBefore: Record<string, number>; // local deletion cutoff for server MAM replay
  retractedMessageIds: Record<string, number>; // prevents cached/MAM originals resurfacing
  locallyDeletedMessageIds: Record<string, number>; // local-only removal survives cache/MAM replay
  pendingRetractions: Record<string, PendingRetraction>;
  activeConversationId: string | null;

  setActiveConversation: (id: string | null) => void;
  upsertConversation: (conv: Conversation) => void;
  addMessage: (msg: ChatMessage, options?: { countAsUnread?: boolean }) => void;
  markRead: (conversationId: string) => void;
  clearMessages: (conversationId: string) => void;
  clearAllHistory: () => void;
  pruneHistoryOlderThan: (cutoffTs: number) => void;
  mergeDuplicatePrivateConversations: () => void;
  deleteConversation: (conversationId: string) => void;
  setComposerDraft: (conversationId: string, draft: string) => void;
  clearComposerDraft: (conversationId: string) => void;
  getComposerDraft: (conversationId: string) => string;
  clearAccountData: (accountId: string) => void;
  updateMessage: (conversationId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  markMessageRetracted: (conversationId: string, messageId: string, at?: number) => void;
  removeLocalMessage: (conversationId: string, messageId: string) => void;
  rememberRetraction: (conversationId: string, targetId: string, request: PendingRetraction) => void;
  toggleMessageStar: (conversationId: string, messageId: string) => void;
  toggleMessageReaction: (conversationId: string, messageId: string, emoji: string) => void;
  setTypingPeer: (conversationId: string, jid: string | null, typing: boolean) => void;
}

const MAX_MESSAGES_PER_CONVERSATION = 500;

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: {},
      messages: {},
      composerDrafts: {},
      typingPeers: {},
      clearedBefore: {},
      retractedMessageIds: {},
      locallyDeletedMessageIds: {},
      pendingRetractions: {},
      activeConversationId: null,

      setActiveConversation: (id) =>
        set((s) => {
          if (id) {
            // Auto mark read
            const conv = s.conversations[id];
            if (conv) {
              return {
                activeConversationId: id,
                conversations: {
                  ...s.conversations,
                  [id]: { ...conv, unreadCount: 0 },
                },
              };
            }
          }
          return { activeConversationId: id };
        }),

      upsertConversation: (conv) =>
        set((s) => {
          if (conv.type === "private" && !isValidBareJid(conv.peerJid)) return s;
          const normalizedConv =
            conv.type === "private"
              ? {
                  ...conv,
                  peerJid: normalizeBareJid(conv.peerJid),
                  id: generateConversationId(conv.accountId, conv.peerJid),
                }
              : conv;
          return {
            conversations: { ...s.conversations, [normalizedConv.id]: normalizedConv },
          };
        }),

      addMessage: (msg, options) =>
        set((s) => {
          if (s.locallyDeletedMessageIds?.[`${msg.conversationId}\u0000${msg.id}`]) return s;
          if (msg.timestamp <= (s.clearedBefore?.[msg.conversationId] ?? 0)) return s;
          const pendingKey = [msg.id, msg.stanzaId].filter(Boolean)
            .map((id) => `${msg.conversationId}\u0000${id}`)
            .find((key) => s.pendingRetractions?.[key] && retractionMatchesMessage(msg, s.pendingRetractions[key]));
          const pending = pendingKey ? s.pendingRetractions[pendingKey] : undefined;
          const nextPending = { ...s.pendingRetractions };
          if (pendingKey) delete nextPending[pendingKey];
          if (s.retractedMessageIds?.[`${msg.conversationId}\u0000${msg.id}`]) {
            msg = { ...msg, body: "", deletedAt: s.retractedMessageIds[`${msg.conversationId}\u0000${msg.id}`], attachments: [], cipherPayload: undefined, omemoEnvelope: undefined };
          } else if (pending) {
            msg = { ...msg, body: "", deletedAt: pending.at, attachments: [], cipherPayload: undefined, omemoEnvelope: undefined };
          }
          const countAsUnread = options?.countAsUnread ?? true;
          const existing = s.messages[msg.conversationId] ?? [];
          if (existing.some((m) => m.id === msg.id)) {
            return s;
          }
          const conv = s.conversations[msg.conversationId];
          return {
            pendingRetractions: nextPending,
            retractedMessageIds: pending ? { ...s.retractedMessageIds, [`${msg.conversationId}\u0000${msg.id}`]: pending.at } : s.retractedMessageIds,
            messages: {
              ...s.messages,
              [msg.conversationId]: [...existing, msg].slice(-MAX_MESSAGES_PER_CONVERSATION),
            },
            conversations: conv
              ? {
                  ...s.conversations,
                  [msg.conversationId]: {
                    ...conv,
                    lastMessage: msg.body,
                    lastMessageAt: msg.timestamp,
                    unreadCount:
                      s.activeConversationId === msg.conversationId
                        ? 0
                        : (conv.unreadCount ?? 0) + (countAsUnread && msg.direction === "in" ? 1 : 0),
                  },
                }
              : s.conversations,
          };
        }),

      markRead: (conversationId) =>
        set((s) => {
          const conv = s.conversations[conversationId];
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: { ...conv, unreadCount: 0 },
            },
          };
        }),

      clearMessages: (conversationId) =>
        set((s) => ({
          messages: { ...s.messages, [conversationId]: [] },
        })),

      clearAllHistory: () =>
        set((s) => {
          const nextConversations: Record<string, Conversation> = {};
          Object.entries(s.conversations).forEach(([id, conv]) => {
            nextConversations[id] = {
              ...conv,
              lastMessage: undefined,
              lastMessageAt: undefined,
              unreadCount: 0,
            };
          });
          return {
            messages: {},
            retractedMessageIds: {},
            locallyDeletedMessageIds: {},
            pendingRetractions: {},
            conversations: nextConversations,
          };
        }),

      pruneHistoryOlderThan: (cutoffTs) =>
        set((s) => {
          const nextMessages: Record<string, ChatMessage[]> = {};
          Object.entries(s.messages).forEach(([convId, list]) => {
            const kept = list.filter((m) => m.timestamp >= cutoffTs);
            if (kept.length > 0) nextMessages[convId] = kept;
          });

          const nextConversations: Record<string, Conversation> = {};
          Object.entries(s.conversations).forEach(([id, conv]) => {
            const convMsgs = nextMessages[id] ?? [];
            const last = convMsgs.length > 0 ? convMsgs[convMsgs.length - 1] : null;
            nextConversations[id] = {
              ...conv,
              lastMessage: last?.body,
              lastMessageAt: last?.timestamp,
              unreadCount: last ? conv.unreadCount : 0,
            };
          });

          return {
            messages: nextMessages,
            retractedMessageIds: Object.fromEntries(Object.entries(s.retractedMessageIds ?? {}).filter(([, at]) => at >= cutoffTs)),
            locallyDeletedMessageIds: Object.fromEntries(Object.entries(s.locallyDeletedMessageIds ?? {}).filter(([, at]) => at >= cutoffTs)),
            pendingRetractions: Object.fromEntries(Object.entries(s.pendingRetractions ?? {}).filter(([, request]) => request.at >= cutoffTs)),
            conversations: nextConversations,
          };
        }),

      mergeDuplicatePrivateConversations: () =>
        set((s) => {
          const nextConversations: Record<string, Conversation> = { ...s.conversations };
          const nextMessages: Record<string, ChatMessage[]> = { ...s.messages };
          let nextActiveId = s.activeConversationId;

          Object.values(s.conversations).forEach((conv) => {
            if (conv.type !== "private") return;

            const canonicalPeerJid = normalizeBareJid(conv.peerJid);
            if (!isValidBareJid(canonicalPeerJid)) {
              delete nextConversations[conv.id];
              delete nextMessages[conv.id];
              if (nextActiveId === conv.id) nextActiveId = null;
              return;
            }
            const canonicalId = generateConversationId(conv.accountId, canonicalPeerJid);
            const sourceId = conv.id;

            const sourceMessages = nextMessages[sourceId] ?? [];
            const targetMessages = nextMessages[canonicalId] ?? [];

            const mergedMessageMap = new Map<string, ChatMessage>();
            [...targetMessages, ...sourceMessages].forEach((m) => {
              mergedMessageMap.set(m.id, {
                ...m,
                conversationId: canonicalId,
                senderJid: normalizeBareJid(m.senderJid),
              });
            });
            const mergedMessages = Array.from(mergedMessageMap.values()).sort((a, b) => a.timestamp - b.timestamp);
            if (mergedMessages.length > 0) nextMessages[canonicalId] = mergedMessages;

            const targetConv = nextConversations[canonicalId];
            const mergedConv: Conversation = {
              ...(targetConv ?? conv),
              id: canonicalId,
              peerJid: canonicalPeerJid,
              accountId: conv.accountId,
              type: "private",
              lastMessageAt: Math.max(targetConv?.lastMessageAt ?? 0, conv.lastMessageAt ?? 0) || undefined,
              lastMessage: (targetConv?.lastMessageAt ?? 0) >= (conv.lastMessageAt ?? 0)
                ? targetConv?.lastMessage ?? conv.lastMessage
                : conv.lastMessage ?? targetConv?.lastMessage,
              unreadCount: (targetConv?.unreadCount ?? 0) + (conv.unreadCount ?? 0),
            };
            nextConversations[canonicalId] = mergedConv;

            if (sourceId !== canonicalId) {
              delete nextConversations[sourceId];
              delete nextMessages[sourceId];
              if (nextActiveId === sourceId) nextActiveId = canonicalId;
            }
          });

          return {
            conversations: nextConversations,
            messages: nextMessages,
            activeConversationId: nextActiveId,
          };
        }),

      deleteConversation: (conversationId) =>
        set((s) => {
          const nextConversations = { ...s.conversations };
          const nextMessages = { ...s.messages };
          const nextDrafts = { ...s.composerDrafts };
          const nextTypingPeers = { ...s.typingPeers };
          delete nextConversations[conversationId];
          delete nextMessages[conversationId];
          delete nextDrafts[conversationId];
          delete nextTypingPeers[conversationId];
          const localDeletes = Object.fromEntries(Object.entries(s.locallyDeletedMessageIds ?? {})
            .filter(([key]) => !key.startsWith(`${conversationId}\u0000`)));
          return {
            conversations: nextConversations,
            messages: nextMessages,
            composerDrafts: nextDrafts,
            typingPeers: nextTypingPeers,
            locallyDeletedMessageIds: localDeletes,
            clearedBefore: { ...s.clearedBefore, [conversationId]: Date.now() },
            activeConversationId: s.activeConversationId === conversationId ? null : s.activeConversationId,
          };
        }),

      setComposerDraft: (conversationId, draft) =>
        set((s) => ({
          composerDrafts: { ...s.composerDrafts, [conversationId]: draft },
        })),

      clearComposerDraft: (conversationId) =>
        set((s) => {
          const nextDrafts = { ...s.composerDrafts };
          delete nextDrafts[conversationId];
          return { composerDrafts: nextDrafts };
        }),

      getComposerDraft: (conversationId) => get().composerDrafts[conversationId] ?? "",

      clearAccountData: (accountId) =>
        set((s) => {
          const nextConversations = { ...s.conversations };
          const nextMessages = { ...s.messages };
          const nextDrafts = { ...s.composerDrafts };
          const nextTypingPeers = { ...s.typingPeers };
          const nextRetractions = { ...s.retractedMessageIds };
          const nextLocalDeletions = { ...s.locallyDeletedMessageIds };
          const nextPendingRetractions = { ...s.pendingRetractions };
          Object.entries(s.conversations).forEach(([id, conv]) => {
            if (conv.accountId !== accountId) return;
            delete nextConversations[id];
            delete nextMessages[id];
            delete nextDrafts[id];
            delete nextTypingPeers[id];
            Object.keys(nextRetractions).filter((key) => key.startsWith(`${id}\u0000`)).forEach((key) => delete nextRetractions[key]);
            Object.keys(nextLocalDeletions).filter((key) => key.startsWith(`${id}\u0000`)).forEach((key) => delete nextLocalDeletions[key]);
            Object.keys(nextPendingRetractions).filter((key) => key.startsWith(`${id}\u0000`)).forEach((key) => delete nextPendingRetractions[key]);
          });
          const activeStillExists =
            s.activeConversationId && nextConversations[s.activeConversationId];
          return {
            conversations: nextConversations,
            messages: nextMessages,
            composerDrafts: nextDrafts,
            typingPeers: nextTypingPeers,
            retractedMessageIds: nextRetractions,
            locallyDeletedMessageIds: nextLocalDeletions,
            pendingRetractions: nextPendingRetractions,
            activeConversationId: activeStillExists ? s.activeConversationId : null,
          };
        }),

      updateMessage: (conversationId, messageId, patch) =>
        set((s) => {
          const existing = s.messages[conversationId] ?? [];
          if (existing.length === 0) return s;
          let touched = false;
          const updated = existing.map((msg) => {
            if (msg.id !== messageId) return msg;
            touched = true;
            return { ...msg, ...patch };
          });
          if (!touched) return s;
          const conv = s.conversations[conversationId];
          const isLatest = updated[updated.length - 1]?.id === messageId;
          return {
            messages: {
              ...s.messages,
              [conversationId]: updated,
            },
            conversations: conv && isLatest && patch.body !== undefined
              ? { ...s.conversations, [conversationId]: { ...conv, lastMessage: patch.body } }
              : s.conversations,
          };
        }),

      markMessageRetracted: (conversationId, messageId, at = Date.now()) =>
        set((s) => {
          const key = `${conversationId}\u0000${messageId}`;
          const existing = s.messages[conversationId] ?? [];
          const updated = existing.map((msg) => msg.id === messageId ? {
            ...msg,
            body: "",
            deletedAt: at,
            attachments: [],
            cipherPayload: undefined,
            omemoEnvelope: undefined,
            decryptFailed: false,
          } : msg);
          const conv = s.conversations[conversationId];
          return {
            retractedMessageIds: { ...s.retractedMessageIds, [key]: at },
            messages: { ...s.messages, [conversationId]: updated },
            conversations: conv && updated[updated.length - 1]?.id === messageId
              ? { ...s.conversations, [conversationId]: { ...conv, lastMessage: "Message deleted" } }
              : s.conversations,
          };
        }),

      removeLocalMessage: (conversationId, messageId) =>
        set((s) => {
          const previous = s.messages[conversationId] ?? [];
          const remaining = previous.filter((message) => message.id !== messageId);
          const conv = s.conversations[conversationId];
          const latest = remaining[remaining.length - 1];
          return {
            locallyDeletedMessageIds: { ...s.locallyDeletedMessageIds, [`${conversationId}\u0000${messageId}`]: Date.now() },
            messages: { ...s.messages, [conversationId]: remaining },
            conversations: conv && previous[previous.length - 1]?.id === messageId
              ? { ...s.conversations, [conversationId]: { ...conv, lastMessage: latest?.body ?? "", lastMessageAt: latest?.timestamp } }
              : s.conversations,
          };
        }),

      rememberRetraction: (conversationId, targetId, request) =>
        set((s) => ({ pendingRetractions: { ...s.pendingRetractions, [`${conversationId}\u0000${targetId}`]: request } })),

      toggleMessageStar: (conversationId, messageId) =>
        set((s) => {
          const existing = s.messages[conversationId] ?? [];
          if (existing.length === 0) return s;
          let touched = false;
          const updated = existing.map((msg) => {
            if (msg.id !== messageId) return msg;
            touched = true;
            return { ...msg, starred: !msg.starred };
          });
          if (!touched) return s;
          return {
            messages: {
              ...s.messages,
              [conversationId]: updated,
            },
          };
        }),

      toggleMessageReaction: (conversationId, messageId, emoji) =>
        set((s) => {
          const existing = s.messages[conversationId] ?? [];
          if (existing.length === 0) return s;
          let touched = false;
          const updated = existing.map((msg) => {
            if (msg.id !== messageId) return msg;
            touched = true;
            const reactions = { ...(msg.reactions ?? {}) };
            const current = reactions[emoji] ?? 0;
            if (current > 0) {
              if (current === 1) delete reactions[emoji];
              else reactions[emoji] = current - 1;
            } else {
              reactions[emoji] = 1;
            }
            return { ...msg, reactions };
          });
          if (!touched) return s;
          return {
            messages: {
              ...s.messages,
              [conversationId]: updated,
            },
          };
        }),

      setTypingPeer: (conversationId, jid, typing) =>
        set((s) => ({
          typingPeers: {
            ...s.typingPeers,
            [conversationId]: typing ? jid : null,
          },
        })),
    }),
    {
      name: "liaot-chat",
      // Message bodies are deliberately NOT persisted here.
      //
      // This store is written to localStorage, which is plain text readable by
      // any script with origin access and by anyone with a profile copy. The
      // previous shape kept the last 100 decrypted messages per conversation
      // (plus ciphertext) there, contradicting the sealed localDb vault.
      // MessageView reloads history per conversation from localDb, so dropping
      // them only changes what is visible before that read completes.
      partialize: (s) => ({
        conversations: s.conversations,
        composerDrafts: s.composerDrafts,
        clearedBefore: s.clearedBefore,
        retractedMessageIds: s.retractedMessageIds,
        locallyDeletedMessageIds: s.locallyDeletedMessageIds,
        pendingRetractions: s.pendingRetractions,
        activeConversationId: s.activeConversationId,
      }),
    }
  )
);
