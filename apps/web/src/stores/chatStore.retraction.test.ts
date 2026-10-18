// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { retractionMatchesMessage, useChatStore, type ChatMessage } from "./chatStore";

const conversationId = "retraction-test";
const original = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "original-id",
  conversationId,
  senderJid: "alice@example.com/phone",
  body: "Private content",
  bodyType: "text",
  direction: "in",
  status: "delivered",
  timestamp: Date.now(),
  attachments: [{ id: "file", fileName: "photo.jpg", mimeType: "image/jpeg", downloadUrl: "https://example.com/photo.jpg", sizeBytes: 42 }],
  ...overrides,
});

beforeEach(() => {
  useChatStore.setState({ messages: {}, conversations: {}, clearedBefore: {}, retractedMessageIds: {}, locallyDeletedMessageIds: {}, pendingRetractions: {} });
});

describe("message retraction", () => {
  it("removes content and keeps a tombstone when an archive replays the original", () => {
    const store = useChatStore.getState();
    store.addMessage(original());
    store.markMessageRetracted(conversationId, "original-id", 1234);
    const deleted = useChatStore.getState().messages[conversationId][0];
    expect(deleted).toMatchObject({ body: "", deletedAt: 1234, attachments: [] });
    useChatStore.setState({ messages: {} });
    useChatStore.getState().addMessage(original());
    expect(useChatStore.getState().messages[conversationId][0]).toMatchObject({ body: "", deletedAt: 1234, attachments: [] });
  });

  it("applies an early group retraction by room stanza id only to its sender", () => {
    const store = useChatStore.getState();
    store.rememberRetraction(conversationId, "room-stanza-id", {
      from: "room@example.com/Alice", type: "groupchat", at: 5678,
    });
    store.addMessage(original({ id: "first", stanzaId: "room-stanza-id", occupantJid: "room@example.com/Bob" }));
    expect(useChatStore.getState().messages[conversationId][0].deletedAt).toBeUndefined();
    store.addMessage(original({ id: "second", stanzaId: "room-stanza-id", occupantJid: "room@example.com/Alice" }));
    expect(useChatStore.getState().messages[conversationId][1]).toMatchObject({ body: "", deletedAt: 5678 });
  });

  it("rejects a retraction from another private sender", () => {
    expect(retractionMatchesMessage(original(), { from: "mallory@example.com", type: "chat", at: 1 })).toBe(false);
    expect(retractionMatchesMessage(original(), { from: "alice@example.com/laptop", type: "chat", at: 1 })).toBe(true);
  });

  it("removes a message only locally and hides it if MAM replays it", () => {
    const store = useChatStore.getState();
    store.addMessage(original());
    store.removeLocalMessage(conversationId, "original-id");
    expect(useChatStore.getState().messages[conversationId]).toEqual([]);
    expect(useChatStore.getState().retractedMessageIds).toEqual({});
    store.addMessage(original());
    expect(useChatStore.getState().messages[conversationId]).toEqual([]);
  });
});
