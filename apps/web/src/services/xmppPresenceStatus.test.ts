// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { XmppClient } from "./xmppAdapter";

describe("custom XMPP presence status", () => {
  it("includes status text while Available", async () => {
    const client = new XmppClient({ jid: "alice@example.test", password: "", wsUrl: "", accountId: "alice" });
    type Node = { name: string; text?: string; children: Node[] };
    const sent: Node[] = [];
    const presence = () => {
      const root: Node = { name: "presence", children: [] };
      const stack = [root];
      const builder = {
        root,
        c(name: string) { const child: Node = { name, children: [] }; stack.at(-1)!.children.push(child); stack.push(child); return builder; },
        t(value: string) { stack.at(-1)!.text = value; return builder; },
        up() { stack.pop(); return builder; },
      };
      return builder;
    };
    const state = client as unknown as {
      _$pres: typeof presence;
      _connection: { send: (stanza: ReturnType<typeof presence>) => void };
      _ensureCapsHash: () => Promise<null>;
      _sendPresence: (show: string, status: string) => Promise<void>;
    };
    state._$pres = presence;
    state._connection = { send: (stanza) => sent.push(stanza.root) };
    state._ensureCapsHash = async () => null;

    await state._sendPresence("available", "In a meeting");

    expect(sent[0].children.find((child) => child.name === "status")?.text).toBe("In a meeting");
    expect(sent[0].children.find((child) => child.name === "show")).toBeUndefined();
  });
});
