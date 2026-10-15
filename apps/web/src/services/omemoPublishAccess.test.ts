// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
// The browser bundle uses the DOM supplied by jsdom; the package's Node
// entry requires optional xmldom, which production browsers do not use.
// @ts-expect-error Strophe does not publish declarations for this bundle path.
import { $iq } from "../../node_modules/strophe.js/dist/strophe.esm.js";
import { XmppClient } from "./xmppAdapter";

function clientWithFakePep(rejectFirstPublish = false) {
  const client = new XmppClient({ jid: "a@example.test", password: "x", wsUrl: "wss://example.test/xmpp-websocket", accountId: "a" });
  const sent: Element[] = [];
  const failedNodes = new Set<string>();
  (client as any)._$iq = $iq;
  (client as any)._connection = {
    sendIQ(stanza: Element, success: () => void, error: () => void) {
      sent.push(stanza);
      const node = stanza.querySelector("publish")?.getAttribute("node");
      if (rejectFirstPublish && node && !failedNodes.has(node)) {
        failedNodes.add(node);
        error();
      } else {
        success();
      }
    },
  };
  return { client, sent };
}

describe("OMEMO PEP publication", () => {
  it("publishes both device lists and bundles with public read access", async () => {
    const { client, sent } = clientWithFakePep();
    await client.publishOmemoDeviceList([123]);
    await client.publishOmemoBundle({
      deviceId: 123, signedPreKeyId: 1, signedPreKeyPublic: "spk", signedPreKeySignature: "sig",
      identityKey: "ik", preKeys: [{ preKeyId: 1, value: "pk" }],
    });
    expect(sent).toHaveLength(4);
    for (const stanza of sent) {
      expect(stanza.querySelector('field[var="pubsub#access_model"] value')?.textContent).toBe("open");
      expect(stanza.querySelector('field[var="FORM_TYPE"] value')?.textContent).toBe("http://jabber.org/protocol/pubsub#publish-options");
      expect(stanza.querySelector("publish-options")).not.toBeNull();
    }
    expect(sent.filter((s) => s.querySelector("list device"))).toHaveLength(2);
    expect(sent.filter((s) => s.querySelector("bundle preKeyPublic"))).toHaveLength(2);
  });

  it("reconfigures an existing presence-only node and retries publication", async () => {
    const { client, sent } = clientWithFakePep(true);
    await client.publishOmemoDeviceList([123]);
    expect(sent).toHaveLength(6);
    const configurations = sent.filter((s) => s.querySelector("configure"));
    expect(configurations).toHaveLength(2);
    for (const stanza of configurations) {
      expect(stanza.querySelector('field[var="pubsub#access_model"] value')?.textContent).toBe("open");
      expect(stanza.querySelector('field[var="FORM_TYPE"] value')?.textContent).toBe("http://jabber.org/protocol/pubsub#node_config");
    }
  });
});
