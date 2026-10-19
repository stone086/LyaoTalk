// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/stores/chatStore";
import { cacheConversations, cacheMessages, clearLocalAccountData, db, restoreLocalAccountHistory, sealLocalAccountHistory } from "./localDb";

beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
});

describe("same-browser encrypted history restoration", () => {
  it("keeps decrypted history password-protected across sign-out and sign-in", async () => {
    const accountId = "same-account";
    const conversation = {
      id: "same-account:jeremy@example.test", accountId, type: "private" as const,
      peerJid: "jeremy@example.test", title: "Jeremy", unreadCount: 0, pinned: false,
    };
    const message = {
      id: "archived-1", conversationId: conversation.id, senderJid: conversation.peerJid,
      body: "readable before logout", bodyType: "text" as const, direction: "in" as const,
      status: "delivered" as const, timestamp: Date.now(), encrypted: true,
    };
    useChatStore.getState().upsertConversation(conversation);
    useChatStore.getState().addMessage(message, { countAsUnread: false });
    await cacheConversations([conversation]);
    await cacheMessages([message]);

    await sealLocalAccountHistory(accountId, "correct password");
    const vault = await db.logoutVaults.get(accountId);
    expect(vault).toBeDefined();
    expect(new TextDecoder().decode(vault!.ciphertext)).not.toContain(message.body);
    await clearLocalAccountData(accountId);
    useChatStore.getState().clearAccountData(accountId);
    expect(await db.messages.count()).toBe(0);

    await expect(restoreLocalAccountHistory(accountId, "wrong password")).rejects.toThrow();
    expect(await restoreLocalAccountHistory(accountId, "correct password")).toBe(true);
    expect(useChatStore.getState().messages[conversation.id]?.[0]?.body).toBe(message.body);
    expect((await db.messages.get(`${conversation.id}:${message.id}`))?.body).toBe(message.body);
    expect(await db.logoutVaults.get(accountId)).toBeUndefined();
  });
});
