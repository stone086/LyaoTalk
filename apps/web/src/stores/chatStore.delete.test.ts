// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useChatStore, type ChatMessage } from "./chatStore";

const message = (conversationId: string, timestamp: number): ChatMessage => ({
  id: `${conversationId}-${timestamp}`,
  conversationId,
  senderJid: "peer@example.com",
  body: "old message",
  bodyType: "text",
  direction: "in",
  status: "delivered",
  timestamp,
});

describe("deleting one conversation", () => {
  it("removes its messages and blocks old archive replay without touching another conversation", () => {
    const store = useChatStore.getState();
    store.addMessage(message("room-a", 1));
    store.addMessage(message("room-b", 2));
    store.deleteConversation("room-a");
    expect(useChatStore.getState().messages["room-a"]).toBeUndefined();
    expect(useChatStore.getState().messages["room-b"]).toHaveLength(1);

    store.addMessage(message("room-a", 1));
    expect(useChatStore.getState().messages["room-a"]).toBeUndefined();

    store.addMessage(message("room-a", Date.now() + 1000));
    expect(useChatStore.getState().messages["room-a"]).toHaveLength(1);
  });
});
