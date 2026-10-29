import { beforeEach, describe, expect, it, vi } from "vitest";

const { post, del, get, setPushEnabled } = vi.hoisted(() => ({
  post: vi.fn(), del: vi.fn(), get: vi.fn(), setPushEnabled: vi.fn(),
}));

vi.mock("./api", () => ({ api: { post, delete: del, get } }));
vi.mock("./xmppAdapter", () => ({ getClient: () => ({ connected: true, setPushEnabled }) }));

import { disableNtfy, enableNtfy, restoreNtfyPush } from "./ntfy";

describe("ntfy XMPP registration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    setPushEnabled.mockResolvedValue(undefined);
    post.mockResolvedValue({ data: { enabled: true, node: "ntfy_abc", topic: "lt_abc", server: "https://ntfy.example.com" } });
    del.mockResolvedValue({});
  });

  it("registers on enable and reconnect, and unregisters on disable", async () => {
    await enableNtfy("alice");
    expect(setPushEnabled).toHaveBeenCalledWith(true, "ntfy_abc");
    await restoreNtfyPush("alice");
    expect(setPushEnabled).toHaveBeenCalledTimes(2);
    await disableNtfy("alice", "ntfy_abc");
    expect(setPushEnabled).toHaveBeenLastCalledWith(false, "ntfy_abc");
    await restoreNtfyPush("alice");
    expect(setPushEnabled).toHaveBeenCalledTimes(3);
  });

  it("does not persist a node when Prosody rejects registration", async () => {
    setPushEnabled.mockRejectedValueOnce(new Error("registration failed"));
    await expect(enableNtfy("alice")).rejects.toThrow("registration failed");
    await restoreNtfyPush("alice");
    expect(setPushEnabled).toHaveBeenCalledTimes(1);
  });
});
