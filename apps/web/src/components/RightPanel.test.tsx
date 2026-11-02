import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { discoverRoomOccupants, decrypt, translate } = vi.hoisted(() => ({
  discoverRoomOccupants: vi.fn(),
  decrypt: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("@/utils/i18n", () => ({ useLanguage: () => ({ t: translate }) }));
vi.mock("@/services/xmppAdapter", () => ({
  getClient: () => ({ connected: true, discoverRoomOccupants }),
}));
vi.mock("@/hooks/usePrivateFileUrl", () => ({
  usePrivateFileUrl: (rawUrl: string) => ({ url: rawUrl, progress: null }),
}));
vi.mock("@/services/aesgcmMedia", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/aesgcmMedia")>(),
  fetchAndDecryptAesgcm: decrypt,
}));
vi.mock("react-hot-toast", () => ({ default: { error: vi.fn() } }));

import RightPanel from "./RightPanel";
import { useAccountStore } from "@/stores/accountStore";
import { useChatStore } from "@/stores/chatStore";
import { useGroupStore } from "@/stores/groupStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  useChatStore.setState({ conversations: {}, messages: {} });
  useGroupStore.setState({ rooms: {}, members: {} });
});

describe("conversation details panel", () => {
  it("shows info, live members, regular and encrypted files, and saved messages without the AI tab", async () => {
    const accountId = "account-1";
    const roomJid = "public-room@conference.example.org";
    const conversationId = `${accountId}:${roomJid}`;
    const aesgcmUrl = `aesgcm://example.org/files/secret.png#${"0".repeat(88)}`;
    useAccountStore.setState({ activeAccountId: accountId, accounts: [{ id: accountId, jid: "alice@example.org", domain: "example.org", presence: "available", connected: true }] });
    useGroupStore.getState().upsertRoom({ accountId, jid: roomJid, name: "public-room", nickname: "alice", isPublic: true, joinState: "joined", subject: "Shared documents" });
    useChatStore.getState().upsertConversation({ id: conversationId, accountId, peerJid: roomJid, title: "public-room", type: "group", unreadCount: 0, pinned: false });
    useChatStore.setState({ messages: { [conversationId]: [
      { id: "regular", conversationId, senderJid: "bob@example.org", body: "", bodyType: "text", direction: "in", status: "delivered", timestamp: 1, attachments: [{ id: "file-1", fileName: "notes.pdf", mimeType: "application/pdf", sizeBytes: 100, downloadUrl: "/files/notes.pdf" }] },
      { id: "encrypted", conversationId, senderJid: "bob@example.org", body: aesgcmUrl, bodyType: "text", direction: "in", status: "delivered", timestamp: 2 },
      { id: "starred", conversationId, senderJid: "alice@example.org", body: "Keep this", bodyType: "text", direction: "out", status: "sent", timestamp: 3, starred: true },
    ] } });
    discoverRoomOccupants.mockResolvedValue([{ jid: `${roomJid}/bob`, name: "bob" }, { jid: `${roomJid}/alice`, name: "alice" }]);
    decrypt.mockResolvedValue("blob:decrypted-file");
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    await act(async () => root.render(<RightPanel conversationId={conversationId} onClose={vi.fn()} />));

    expect(element.querySelectorAll("button[title^='right.'], button[title='Starred']")).toHaveLength(4);
    expect(element.querySelector("button[title='right.ai']")).toBeNull();
    expect(element.textContent).toContain("Shared documents");
    expect(element.textContent).toContain("right.type.group");
    await act(async () => element.querySelector<HTMLButtonElement>("button[title='right.members']")!.click());
    expect(discoverRoomOccupants).toHaveBeenCalledWith(roomJid);
    expect(element.textContent).toContain("bob");
    expect(element.textContent).toContain("alice");

    await act(async () => element.querySelector<HTMLButtonElement>("button[title='right.files']")!.click());
    expect(element.textContent).toContain("notes.pdf");
    const encryptedButton = Array.from(element.querySelectorAll("button")).find((button) => button.textContent?.includes("secret.png"));
    expect(encryptedButton).toBeDefined();
    await act(async () => encryptedButton!.click());
    expect(decrypt).toHaveBeenCalledWith(aesgcmUrl, { accountId });
    expect(anchorClick).toHaveBeenCalled();

    await act(async () => element.querySelector<HTMLButtonElement>("button[title='Starred']")!.click());
    expect(element.textContent).toContain("Keep this");

    await act(async () => root.unmount());
    element.remove();
  });
});
