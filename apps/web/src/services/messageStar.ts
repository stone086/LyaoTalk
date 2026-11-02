import { cacheMessages } from "@/services/localDb";
import { useChatStore } from "@/stores/chatStore";

/** Keep the local message cache in step with the in-memory starred state. */
export async function toggleAndCacheMessageStar(conversationId: string, messageId: string): Promise<void> {
  const store = useChatStore.getState();
  store.toggleMessageStar(conversationId, messageId);
  const updated = useChatStore.getState().messages[conversationId]?.find((message) => message.id === messageId);
  if (updated) await cacheMessages([updated]);
}
