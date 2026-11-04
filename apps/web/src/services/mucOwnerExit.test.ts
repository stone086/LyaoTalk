import { describe, expect, it } from "vitest";
import { XmppClient } from "./xmppAdapter";

const xml = (value: string) => new DOMParser().parseFromString(value, "application/xml").documentElement;

function connectedClient(onIq: (stanza: Element) => Element) {
  const client = new XmppClient({ jid: "owner@lyaot.example.org", password: "", wsUrl: "", accountId: "owner" });
  const internals = client as unknown as { _connected: boolean; _connection: unknown; _$iq: unknown };
  internals._connected = true;
  internals._$iq = (attributes: Record<string, string>) => {
    const root = xml("<iq />");
    for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
    let cursor = root;
    const builder = {
      c(name: string, attributes: Record<string, string> = {}) {
        const child = root.ownerDocument.createElementNS(attributes.xmlns ?? cursor.namespaceURI, name);
        for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
        cursor.appendChild(child);
        cursor = child;
        return builder;
      },
      tree() { return root; },
    };
    return builder;
  };
  internals._connection = { sendIQ(stanza: Element, resolve: (response: Element) => void) { resolve(onIq(stanza)); } };
  return client;
}

describe("owner room exit protocol", () => {
  it("reads owner affiliation from the server", async () => {
    const client = connectedClient((stanza) => {
      expect(stanza.getAttribute("type")).toBe("get");
      expect(stanza.getAttribute("to")).toBe("family@conference.lyaot.example.org");
      expect(stanza.getElementsByTagName("item")[0].getAttribute("affiliation")).toBe("owner");
      return xml('<iq><query><item jid="owner@lyaot.example.org" /></query></iq>');
    });
    expect(await client.fetchRoomAffiliations("family@conference.lyaot.example.org", "owner"))
      .toEqual(["owner@lyaot.example.org"]);
  });

  it("transfers ownership with MUC admin IQ", async () => {
    const client = connectedClient((stanza) => {
      expect(stanza.getAttribute("type")).toBe("set");
      const query = stanza.getElementsByTagName("query")[0];
      expect(query.getAttribute("xmlns")).toBe("http://jabber.org/protocol/muc#admin");
      expect(query.getElementsByTagName("item")[0].getAttribute("jid")).toBe("member@lyaot.example.org");
      expect(query.getElementsByTagName("item")[0].getAttribute("affiliation")).toBe("owner");
      return xml("<iq type='result' />");
    });
    await client.setRoomAffiliation("family@conference.lyaot.example.org", "member@lyaot.example.org", "owner");
  });

  it("dissolves the room with MUC owner IQ", async () => {
    const client = connectedClient((stanza) => {
      expect(stanza.getAttribute("type")).toBe("set");
      const query = stanza.getElementsByTagName("query")[0];
      expect(query.getAttribute("xmlns")).toBe("http://jabber.org/protocol/muc#owner");
      expect(query.getElementsByTagName("destroy")).toHaveLength(1);
      return xml("<iq type='result' />");
    });
    await client.destroyRoom("family@conference.lyaot.example.org");
  });

  it("grants room membership and administrator affiliation", async () => {
    const affiliations: string[] = [];
    const client = connectedClient((stanza) => {
      const item = stanza.getElementsByTagName("item")[0];
      affiliations.push(item.getAttribute("affiliation") ?? "");
      expect(item.getAttribute("jid")).toBe("member@lyaot.example.org");
      return xml("<iq type='result' />");
    });
    await client.setRoomAffiliation("family@conference.lyaot.example.org", "member@lyaot.example.org", "member");
    await client.setRoomAffiliation("family@conference.lyaot.example.org", "member@lyaot.example.org", "admin");
    expect(affiliations).toEqual(["member", "admin"]);
  });

  it("kicks an occupant by room nickname", async () => {
    const client = connectedClient((stanza) => {
      const item = stanza.getElementsByTagName("item")[0];
      expect(item.getAttribute("nick")).toBe("guest");
      expect(item.getAttribute("role")).toBe("none");
      return xml("<iq type='result' />");
    });
    await client.kickRoomOccupant("family@conference.lyaot.example.org", "guest");
  });
});
