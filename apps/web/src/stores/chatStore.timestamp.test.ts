// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useChatStore, type ChatMessage } from "./chatStore";

const message = (id: string, timestamp: number): ChatMessage => ({
  id,
  conversationId: "history-date-test",
  senderJid: "room@conference.example.com",
  body: id,
  bodyType: "text",
  direction: "in",
  status: "delivered",
  timestamp,
});

describe("correcting archived message time", () => {
  it("moves a replayed message back to its original date", () => {
    const store = useChatStore.getState();
    store.addMessage(message("old-location", 300));
    store.addMessage(message("new-message", 200));
    store.updateMessage("history-date-test", "old-location", { timestamp: 100 });
    expect(useChatStore.getState().messages["history-date-test"].map(({ id }) => id)).toEqual([
      "old-location", "new-message",
    ]);
    expect(useChatStore.getState().messages["history-date-test"][0].timestamp).toBe(100);
  });
});
