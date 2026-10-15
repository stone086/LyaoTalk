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

interface ChatState {
  conversations: Record<string, Conversation>;
  messages: Record<string, ChatMessage[]>; // keyed by conversationId
  composerDrafts: Record<string, string>;
  typingPeers: Record<string, string | null>;
  clearedBefore: Record<string, number>; // local deletion cutoff for server MAM replay
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
          if (msg.timestamp <= (s.clearedBefore?.[msg.conversationId] ?? 0)) return s;
          const countAsUnread = options?.countAsUnread ?? true;
          const existing = s.messages[msg.conversationId] ?? [];
          if (existing.some((m) => m.id === msg.id)) {
            return s;
          }
          const conv = s.conversations[msg.conversationId];
          return {
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
          return {
            conversations: nextConversations,
            messages: nextMessages,
            composerDrafts: nextDrafts,
            typingPeers: nextTypingPeers,
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
          Object.entries(s.conversations).forEach(([id, conv]) => {
            if (conv.accountId !== accountId) return;
            delete nextConversations[id];
            delete nextMessages[id];
            delete nextDrafts[id];
            delete nextTypingPeers[id];
          });
          const activeStillExists =
            s.activeConversationId && nextConversations[s.activeConversationId];
          return {
            conversations: nextConversations,
            messages: nextMessages,
            composerDrafts: nextDrafts,
            typingPeers: nextTypingPeers,
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
          return {
            messages: {
              ...s.messages,
              [conversationId]: updated,
            },
          };
        }),

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
      partialize: (s) => ({
        conversations: s.conversations,
        messages: Object.fromEntries(
          Object.entries(s.messages).map(([conversationId, list]) => [
            conversationId,
            list.slice(-100),
          ])
        ),
        composerDrafts: s.composerDrafts,
        clearedBefore: s.clearedBefore,
        activeConversationId: s.activeConversationId,
      }),
    }
  )
);
