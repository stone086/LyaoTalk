import { describe, expect, it } from "vitest";
import { parseMucBookmarks } from "./xmppAdapter";

describe("XEP-0402 room bookmarks", () => {
  it("reads a phone-created room with its server JID, title, nick and autojoin flag", () => {
    const stanza = new DOMParser().parseFromString(`
      <iq type="result"><pubsub xmlns="http://jabber.org/protocol/pubsub">
        <items node="urn:xmpp:bookmarks:1"><item id="family@conference.lyaot.example.org">
          <conference xmlns="urn:xmpp:bookmarks:1" name="Family" autojoin="1"><nick>alice</nick></conference>
        </item></items>
      </pubsub></iq>`, "application/xml").documentElement;
    expect(parseMucBookmarks(stanza)).toEqual([{
      jid: "family@conference.lyaot.example.org",
      name: "Family",
      nickname: "alice",
      autojoin: true,
    }]);
  });

  it("reads legacy private XML bookmarks used by older mobile clients", () => {
    const stanza = new DOMParser().parseFromString(`
      <iq type="result"><query xmlns="jabber:iq:private"><storage xmlns="storage:bookmarks">
        <conference jid="friends@conference.lyaot.example.org" name="Friends" autojoin="true"><nick>alice</nick></conference>
      </storage></query></iq>`, "application/xml").documentElement;
    expect(parseMucBookmarks(stanza)).toEqual([{
      jid: "friends@conference.lyaot.example.org",
      name: "Friends",
      nickname: "alice",
      autojoin: true,
    }]);
  });
});
