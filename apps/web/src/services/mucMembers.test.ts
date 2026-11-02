import { describe, expect, it, vi } from "vitest";
import { XmppClient } from "./xmppAdapter";

const xml = (value: string) => new DOMParser().parseFromString(value, "application/xml").documentElement;

describe("MUC member discovery", () => {
  it("reads namespaced member presence and unavailable updates", () => {
    const client = new XmppClient({ jid: "alice@example.org", password: "", wsUrl: "", accountId: "alice" });
    let presenceHandler: ((stanza: Element) => boolean) | undefined;
    const internals = client as unknown as {
      _connection: { addHandler: (handler: (stanza: Element) => boolean, ns: string | null, name: string) => void };
      _setupHandlers: () => void;
    };
    internals._connection = {
      addHandler(handler, _ns, name) { if (name === "presence") presenceHandler = handler; },
    };
    internals._setupHandlers();
    const member = vi.fn();
    client.on("room.member", member);

    presenceHandler!(xml('<presence from="public-room@conference.example.org/bob"><m:x xmlns:m="http://jabber.org/protocol/muc#user"><m:item jid="bob@example.org" role="moderator" affiliation="owner" /></m:x></presence>'));
    expect(member).toHaveBeenCalledWith(expect.objectContaining({ roomJid: "public-room@conference.example.org", jid: "bob@example.org", nickname: "bob", affiliation: "owner" }));

    presenceHandler!(xml('<presence from="public-room@conference.example.org/bob" type="unavailable"><m:x xmlns:m="http://jabber.org/protocol/muc#user"><m:item jid="bob@example.org" /></m:x></presence>'));
    expect(member).toHaveBeenLastCalledWith(expect.objectContaining({ jid: "bob@example.org", presence: "unavailable" }));
  });

  it("requests the current occupant list from the room", async () => {
    const client = new XmppClient({ jid: "alice@example.org", password: "", wsUrl: "", accountId: "alice" });
    const internals = client as unknown as {
      _connected: boolean;
      _$iq: (attrs: Record<string, string>) => { c: () => { tree: () => Element } };
      _connection: { sendIQ: (request: Element, resolve: (response: Element) => void) => void };
    };
    internals._connected = true;
    internals._$iq = (attrs) => ({ c: () => ({ tree: () => xml(`<iq to="${attrs.to}" />`) }) });
    internals._connection = {
      sendIQ(request, resolve) {
        expect(request.getAttribute("to")).toBe("public-room@conference.example.org");
        resolve(xml('<iq><query><item jid="public-room@conference.example.org/bob" name="bob"/><item jid="public-room@conference.example.org/alice" name="alice"/><item jid="other@conference.example.org/else"/></query></iq>'));
      },
    };
    expect(await client.discoverRoomOccupants("public-room@conference.example.org")).toEqual([
      { jid: "public-room@conference.example.org/bob", name: "bob" },
      { jid: "public-room@conference.example.org/alice", name: "alice" },
    ]);
  });
});
