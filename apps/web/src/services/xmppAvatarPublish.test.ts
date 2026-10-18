// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { XmppClient } from "./xmppAdapter";

afterEach(() => vi.unstubAllGlobals());

describe("XMPP avatar publication", () => {
  it("publishes data before metadata and reports server rejection", async () => {
    vi.stubGlobal("crypto", { subtle: { digest: async () => new Uint8Array(20).buffer } });
    const client = new XmppClient({ jid: "alice@example.test", password: "", wsUrl: "", accountId: "alice" });
    const nodes: string[] = [];
    const builder = {
      c(name: string, attrs?: Record<string, string>) {
        if (name === "publish") nodes.push(attrs?.node ?? "");
        return builder;
      },
      t() { return builder; },
      tree() { return {}; },
    };
    const state = client as unknown as {
      _connected: boolean;
      _$iq: () => typeof builder;
      _connection: { sendIQ: (_iq: object, success: () => void, error: () => void) => void };
    };
    state._connected = true;
    state._$iq = () => builder;
    state._connection = { sendIQ: (_iq, success) => success() };
    await client.publishPepAvatar(new Uint8Array([1, 2, 3]), "image/jpeg", 192, 192);
    expect(nodes).toEqual(["urn:xmpp:avatar:data", "urn:xmpp:avatar:metadata"]);

    state._connection = { sendIQ: (_iq, _success, error) => error() };
    await expect(client.publishPepAvatar(new Uint8Array([1]))).rejects.toThrow("Avatar data publish failed");
  });
});
