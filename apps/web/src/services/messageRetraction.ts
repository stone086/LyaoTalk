import { useChatStore } from "@/stores/chatStore";
import { cacheMessages } from "@/services/localDb";
import { removeFromIndex } from "@/services/searchIndex";

/** Remove message content from memory, persistent cache, and local search. */
export function applyMessageRetraction(conversationId: string, messageId: string): void {
  const store = useChatStore.getState();
  store.markMessageRetracted(conversationId, messageId);
  const tombstone = useChatStore.getState().messages[conversationId]?.find((message) => message.id === messageId);
  if (tombstone) void cacheMessages([tombstone]).catch(() => {});
  const accountId = useChatStore.getState().conversations[conversationId]?.accountId;
  removeFromIndex(conversationId, messageId, accountId);
}
