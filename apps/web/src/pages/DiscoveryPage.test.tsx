import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { discoverRooms, joinRoom, publishMucBookmark, navigate, upsertRoom, upsertConversation, translate } = vi.hoisted(() => ({
  discoverRooms: vi.fn(),
  joinRoom: vi.fn(),
  publishMucBookmark: vi.fn(),
  navigate: vi.fn(),
  upsertRoom: vi.fn(),
  upsertConversation: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("@/utils/i18n", () => ({ useLanguage: () => ({ t: translate }) }));
vi.mock("@/services/api", () => ({ api: { get: vi.fn(async () => ({
  data: { version: "2.3.7", uptime_seconds: 3600, user_count: 4, avg_response_ms: 12 },
})) } }));
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) => selector({
    activeAccountId: "account-1",
    accounts: [{ id: "account-1", jid: "alice@example.org", domain: "example.org", connected: true }],
  }),
}));
vi.mock("@/services/xmppAdapter", () => ({
  getClient: () => ({ connected: true, discoverRooms, joinRoom, publishMucBookmark }),
}));
vi.mock("@/stores/groupStore", () => ({ useGroupStore: { getState: () => ({ upsertRoom }) } }));
vi.mock("@/stores/chatStore", () => ({ useChatStore: { getState: () => ({ upsertConversation }) } }));
vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import DiscoveryPage from "./DiscoveryPage";
import { api } from "@/services/api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
});

describe("public group discovery", () => {
  it("lists Prosody rooms and joins the selected group", async () => {
    discoverRooms.mockResolvedValue([{ jid: "public-room@conference.example.org" }]);
    joinRoom.mockResolvedValue(undefined);
    publishMucBookmark.mockResolvedValue(undefined);
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    await act(async () => root.render(<DiscoveryPage />));

    expect(discoverRooms).toHaveBeenCalledWith("conference.example.org");
    expect(element.textContent).toContain("public-room");
    expect(element.textContent).toContain("4 discovery.users");
    expect(element.textContent).toContain("12ms");
    expect(api.get).not.toHaveBeenCalledWith("/discovery/groups");
    const groupCard = element.querySelector(".hover\\:bg-surface-800\\/60");
    expect(groupCard).not.toBeNull();
    expect(element.querySelector(".hover\\:bg-surface-50")).toBeNull();

    const joinButton = element.querySelector<HTMLButtonElement>("button[title='discovery.join']");
    expect(joinButton).not.toBeNull();
    await act(async () => joinButton!.click());
    expect(joinRoom).toHaveBeenCalledWith("public-room@conference.example.org", "alice");
    expect(publishMucBookmark).toHaveBeenCalledWith(expect.objectContaining({ jid: "public-room@conference.example.org" }));
    expect(upsertRoom).toHaveBeenCalledWith(expect.objectContaining({ jid: "public-room@conference.example.org" }));
    expect(upsertConversation).toHaveBeenCalledWith(expect.objectContaining({ peerJid: "public-room@conference.example.org" }));
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/chat\//));

    await act(async () => root.unmount());
    element.remove();
  });
});
