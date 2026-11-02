import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { db, getLocalMessages } from "./localDb";
import { toggleAndCacheMessageStar } from "./messageStar";
import { useChatStore } from "@/stores/chatStore";

afterEach(async () => {
  await db.messages.clear();
  useChatStore.setState({ messages: {} });
});

describe("starred message storage", () => {
  it("retains star and unstar changes after history is reloaded", async () => {
    const conversationId = "account:public-room@conference.example.org";
    const message = {
      id: "message-1", conversationId, senderJid: "alice@example.org",
      body: "A useful note", bodyType: "text" as const, direction: "in" as const,
      status: "delivered" as const, timestamp: Date.now(),
    };
    useChatStore.setState({ messages: { [conversationId]: [message] } });

    await toggleAndCacheMessageStar(conversationId, message.id);
    expect((await getLocalMessages(conversationId))[0].starred).toBe(true);

    await toggleAndCacheMessageStar(conversationId, message.id);
    expect((await getLocalMessages(conversationId))[0].starred).toBe(false);
  });
});
