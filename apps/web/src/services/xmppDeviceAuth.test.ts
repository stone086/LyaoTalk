import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ options: vi.fn(), connect: vi.fn() }));
vi.mock("strophe.js", () => {
  class SASLOAuthBearer {}
  class Connection {
    constructor(_url: string, options: unknown) { mocks.options(options); }
    connect(...args: unknown[]) { mocks.connect(...args); }
  }
  return { Strophe: { Connection, SASLOAuthBearer, Status: {} }, $msg: vi.fn(), $iq: vi.fn(), $pres: vi.fn() };
});

import { XmppClient } from "./xmppAdapter";

describe("device credential XMPP login", () => {
  it("offers only OAUTHBEARER for a device token", async () => {
    const client = new XmppClient({
      jid: "alice@example.org", password: "secret-token:example", wsUrl: "wss://example.org/xmpp-websocket", accountId: "a",
    });
    void client.connect();
    await vi.waitFor(() => expect(mocks.options).toHaveBeenCalled());
    expect(mocks.options.mock.calls[0][0].mechanisms).toHaveLength(1);
  });
});
