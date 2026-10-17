import { describe, expect, it } from "vitest";
import { XmppClient, parseMucBookmarks } from "./xmppAdapter";

describe("XEP-0402 room bookmarks", () => {
  it("reads a phone-created room with its server JID, title, nick and autojoin flag", () => {
    const stanza = new DOMParser().parseFromString(`
      <iq type="result"><pubsub xmlns="http://jabber.org/protocol/pubsub">
        <items node="urn:xmpp:bookmarks:1"><item id="family@conference.lyaot.2-yc.com">
          <conference xmlns="urn:xmpp:bookmarks:1" name="Family" autojoin="1"><nick>lyao1</nick></conference>
        </item></items>
      </pubsub></iq>`, "application/xml").documentElement;
    expect(parseMucBookmarks(stanza)).toEqual([{
      jid: "family@conference.lyaot.2-yc.com",
      name: "Family",
      nickname: "lyao1",
      autojoin: true,
    }]);
  });

  it("reads legacy private XML bookmarks used by older mobile clients", () => {
    const stanza = new DOMParser().parseFromString(`
      <iq type="result"><query xmlns="jabber:iq:private"><storage xmlns="storage:bookmarks">
        <conference jid="friends@conference.lyaot.2-yc.com" name="Friends" autojoin="true"><nick>lyao1</nick></conference>
      </storage></query></iq>`, "application/xml").documentElement;
    expect(parseMucBookmarks(stanza)).toEqual([{
      jid: "friends@conference.lyaot.2-yc.com",
      name: "Friends",
      nickname: "lyao1",
      autojoin: true,
    }]);
  });

  it("removes a room from legacy PEP bookmarks without deleting other rooms", async () => {
    const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml").documentElement;
    const iq = (attributes: Record<string, string>) => {
      const root = xml("<iq />");
      for (const [key, value] of Object.entries(attributes)) root.setAttribute(key, value);
      let cursor = root;
      const builder = {
        c(name: string, attrs: Record<string, string> = {}) {
          const child = root.ownerDocument.createElementNS(attrs.xmlns ?? cursor.namespaceURI, name);
          for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
          cursor.appendChild(child);
          cursor = child;
          return builder;
        },
        cnode(node: Element) { cursor.appendChild(root.ownerDocument.importNode(node, true)); return builder; },
        tree() { return root; },
      };
      return builder;
    };
    let storage = xml(`<storage xmlns="storage:bookmarks">
      <conference jid="omemo-test@conference.lyaot.2-yc.com" name="OMEMO Test" autojoin="true" />
      <conference jid="keep@conference.lyaot.2-yc.com" name="Keep" autojoin="true" />
    </storage>`);
    const client = new XmppClient({ jid: "lyao1@lyaot.2-yc.com", password: "", wsUrl: "", accountId: "lyao1" });
    const internals = client as unknown as { _connected: boolean; _connection: unknown; _$iq: typeof iq };
    internals._connected = true;
    internals._$iq = iq;
    internals._connection = {
      sendIQ(stanza: Element, resolve: (result: Element) => void) {
        const type = stanza.getAttribute("type");
        const items = stanza.getElementsByTagName("items")[0];
        if (items?.getAttribute("node") === "urn:xmpp:bookmarks:1") {
          resolve(xml(`<iq type="result"><pubsub><items node="urn:xmpp:bookmarks:1" /></pubsub></iq>`));
        } else if (items?.getAttribute("node") === "storage:bookmarks") {
          const result = xml(`<iq type="result"><pubsub><items node="storage:bookmarks"><item id="current" /></items></pubsub></iq>`);
          result.getElementsByTagName("item")[0].appendChild(result.ownerDocument.importNode(storage, true));
          resolve(result);
        } else if (type === "set" && stanza.getElementsByTagName("publish")[0]?.getAttribute("node") === "storage:bookmarks") {
          storage = stanza.getElementsByTagName("storage")[0].cloneNode(true) as Element;
          resolve(xml(`<iq type="result" />`));
        } else {
          resolve(xml(`<iq type="result"><query xmlns="jabber:iq:private"><storage xmlns="storage:bookmarks" /></query></iq>`));
        }
      },
    };
    await client.retractMucBookmark("omemo-test@conference.lyaot.2-yc.com");
    expect(parseMucBookmarks(storage).map((bookmark) => bookmark.jid)).toEqual(["keep@conference.lyaot.2-yc.com"]);
  });
});
