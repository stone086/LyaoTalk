import { describe, expect, it } from "vitest";
import { XmppClient } from "./xmppAdapter";

describe("XEP-0357 registration", () => {
  it("addresses the configured push component and uses a stable node", async () => {
    const client = new XmppClient({
      accountId: "alice", jid: "alice@example.com", password: "test", wsUrl: "wss://example.com/xmpp",
    });
    const sent: object[] = [];
    const state = client as unknown as {
      _connected: boolean;
      _$iq: (attrs: Record<string, string>) => { c: (name: string, childAttrs: Record<string, string>) => { tree: () => object } };
      _connection: { sendIQ: (stanza: object, success: () => void) => void };
    };
    state._connected = true;
    state._$iq = ({ type }) => ({
      c: (name, attrs) => ({ tree: () => ({ type, name, attrs }) }),
    });
    state._connection = { sendIQ: (stanza, success) => { sent.push(stanza); success(); } };

    await client.setPushEnabled(true, "device_1");
    await client.setPushEnabled(false, "device_1");
    expect(sent).toEqual([
      { type: "set", name: "enable", attrs: { xmlns: "urn:xmpp:push:0", jid: "push.example.com", node: "device_1" } },
      { type: "set", name: "disable", attrs: { xmlns: "urn:xmpp:push:0", jid: "push.example.com", node: "device_1" } },
    ]);
  });

  it("rejects registration before the XMPP session connects", async () => {
    const client = new XmppClient({
      accountId: "alice", jid: "alice@example.com", password: "test", wsUrl: "wss://example.com/xmpp",
    });
    await expect(client.setPushEnabled(true, "device_1")).rejects.toThrow("not connected");
  });
});
