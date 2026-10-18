// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveXmppWsUrl } from "./xmppEndpoint";

afterEach(() => vi.restoreAllMocks());

describe("XMPP endpoint discovery", () => {
  it("uses the local proxy for the site account", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await resolveXmppWsUrl(`alice@${window.location.hostname}`)).toContain("/xmpp-websocket");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses an external server's advertised WebSocket endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ links: [{ rel: "urn:xmpp:alt-connections:websocket", href: "wss://upload.chat.52nbc.com/xmpp-websocket" }] }),
    } as Response);
    expect(await resolveXmppWsUrl("test1@chat.52nbc.com")).toBe("wss://upload.chat.52nbc.com/xmpp-websocket");
    expect(fetchMock).toHaveBeenCalledWith("https://chat.52nbc.com/.well-known/host-meta.json", expect.any(Object));
  });

  it("rejects insecure external WebSocket endpoints", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ links: [{ rel: "urn:xmpp:alt-connections:websocket", href: "ws://example.test/xmpp" }] }),
    } as Response);
    await expect(resolveXmppWsUrl("alice@example.test")).rejects.toThrow("Insecure");
  });
});
