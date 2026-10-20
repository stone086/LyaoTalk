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

describe("XMPP avatar retrieval", () => {
  it("falls back to the latest data item when the metadata ID is unavailable", async () => {
    const client = new XmppClient({ jid: "alice@example.test", password: "", wsUrl: "", accountId: "alice" });
    const requests: Array<{ node?: string; itemId?: string }> = [];
    let request: { node?: string; itemId?: string } = {};
    const builder = {
      c(name: string, attrs?: Record<string, string>) {
        if (name === "items") request.node = attrs?.node;
        if (name === "item") request.itemId = attrs?.id;
        return builder;
      },
      tree() { return request; },
    };
    const state = client as unknown as {
      _connected: boolean;
      _$iq: () => typeof builder;
      _connection: { sendIQ: (iq: { node?: string; itemId?: string }, success: (result: Element) => void) => void };
    };
    state._connected = true;
    state._$iq = () => { request = {}; return builder; };
    state._connection = {
      sendIQ(iq, success) {
        requests.push({ ...iq });
        const xml = iq.node === "urn:xmpp:avatar:metadata"
          ? '<iq><item><metadata><info id="old-hash" type="image/jpeg" /></metadata></item></iq>'
          : iq.itemId
            ? "<iq><items /></iq>"
            : "<iq><item><data>YWJj</data></item></iq>";
        success(new DOMParser().parseFromString(xml, "application/xml").documentElement);
      },
    };
    await expect(client.fetchPepAvatar("alice@example.test")).resolves.toBe("data:image/jpeg;base64,YWJj");
    expect(requests).toEqual([
      { node: "urn:xmpp:avatar:metadata" },
      { node: "urn:xmpp:avatar:data", itemId: "old-hash" },
      { node: "urn:xmpp:avatar:data" },
    ]);
  });
});
