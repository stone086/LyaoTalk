// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { XmppClient } from "../xmppAdapter";

describe("XEP-0215 ICE discovery", () => {
  it("advertises direct audio/video Jingle with a matching caps disco node", () => {
    const client = new XmppClient({
      jid: "alice@liaot.example", password: "", wsUrl: "wss://liaot.example/xmpp-websocket", accountId: "alice",
    });
    let handleDisco: ((iq: Element) => boolean) | undefined;
    const elements: Array<{ name: string; attrs: Record<string, string> }> = [];
    const builder = {
      c(name: string, attrs: Record<string, string>) { elements.push({ name, attrs }); return this; },
      up() { return this; },
    };
    const internal = client as any;
    internal._$iq = () => builder;
    internal._connection = {
      addHandler: (handler: (iq: Element) => boolean) => { handleDisco = handler; },
      send: vi.fn(),
    };
    internal._setupDiscoHandler();
    const iq = new DOMParser().parseFromString(
      '<iq from="bob@remote.example/phone" id="disco-1"><query xmlns="http://jabber.org/protocol/disco#info" node="https://liaot.dev/caps#hash"/></iq>',
      "text/xml",
    ).documentElement;
    expect(handleDisco?.(iq)).toBe(true);
    expect(elements.find(({ name }) => name === "query")?.attrs.node).toBe("https://liaot.dev/caps#hash");
    const features = elements.filter(({ name }) => name === "feature").map(({ attrs }) => attrs.var);
    expect(features).toEqual(expect.arrayContaining([
      "urn:xmpp:jingle:1",
      "urn:xmpp:jingle:apps:rtp:1",
      "urn:xmpp:jingle:apps:rtp:audio",
      "urn:xmpp:jingle:apps:rtp:video",
      "urn:xmpp:jingle:apps:dtls:0",
      "urn:xmpp:jingle:transports:ice-udp:1",
    ]));
    // LiaoT currently accepts direct Jingle IQs, not XEP-0353 proposals.
    expect(features).not.toContain("urn:xmpp:jingle-message:0");
  });

  it("uses time-limited TURN credentials returned by the account's own server", async () => {
    const client = new XmppClient({
      jid: "alice@liaot.example", password: "", wsUrl: "wss://liaot.example/xmpp-websocket", accountId: "alice",
    });
    const sentTo: string[] = [];
    const internal = client as unknown as {
      _connected: boolean;
      _$iq: (attrs: { to: string }) => { c: () => { tree: () => Element } };
      _connection: { sendIQ: (iq: Element, ok: (result: Element) => void) => void };
    };
    internal._connected = true;
    internal._$iq = (attrs) => {
      sentTo.push(attrs.to);
      return { c: () => ({ tree: () => document.createElement("iq") }) };
    };
    internal._connection = {
      sendIQ: (_iq, ok) => ok(new DOMParser().parseFromString(
        `<iq><services xmlns="urn:xmpp:extdisco:2">
          <service type="stun" host="turn.liaot.example" port="3478" transport="udp"/>
          <service type="turn" host="turn.liaot.example" port="3478" transport="tcp" username="temporary" password="secret"/>
          <service type="turn" host="127.0.0.1" port="3478" username="bad"/>
        </services></iq>`, "text/xml",
      ).documentElement),
    };
    const servers = await client.fetchIceServers();
    expect(sentTo).toEqual(["liaot.example"]);
    expect(servers).toContainEqual({ urls: "turn:turn.liaot.example:3478?transport=tcp", username: "temporary", credential: "secret" });
    expect(servers).toContainEqual({ urls: "stun:turn.liaot.example:3478" });
  });

  it("routes Jingle to the currently known full resource", () => {
    const client = new XmppClient({
      jid: "alice@liaot.example", password: "", wsUrl: "wss://liaot.example/xmpp-websocket", accountId: "alice",
    });
    const destinations: string[] = [];
    const iqIds: string[] = [];
    const jingleNodes: Element[] = [];
    const internal = client as unknown as {
      _connected: boolean;
      _lastFullJidByBare: Map<string, string>;
      _recentMessageFullJidByBare: Map<string, string>;
      _availableFullJidsByBare: Map<string, Set<string>>;
      _$iq: (attrs: { to: string; id: string }) => { cnode: (node: Element) => object; tree: () => Element };
      _connection: { jid: string; send: (iq: object) => void; sendIQ: (iq: Element, ok: () => void, fail: (error: Element) => void) => void };
    };
    internal._connected = true;
    internal._lastFullJidByBare.set("bob@remote.example", "bob@remote.example/current-resource");
    internal._$iq = (attrs) => {
      destinations.push(attrs.to);
      iqIds.push(attrs.id);
      return { cnode: (node: Element) => { jingleNodes.push(node); return {}; }, tree: () => document.createElement("iq") };
    };
    internal._connection = { jid: "alice@liaot.example/browser", send: vi.fn(), sendIQ: vi.fn() };
    client.sendJingle("bob@remote.example", "test-session", '<jingle xmlns="urn:xmpp:jingle:1" action="session-initiate" sid="test-session"/>');
    expect(destinations).toEqual(["bob@remote.example/current-resource"]);
    expect(iqIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(jingleNodes[0].getAttribute("initiator")).toBe("alice@liaot.example/browser");
    expect(jingleNodes[0].hasAttribute("responder")).toBe(false);
    internal._recentMessageFullJidByBare.set("bob@remote.example", "bob@remote.example/recent-message");
    client.sendJingle("bob@remote.example", "second-session", '<jingle xmlns="urn:xmpp:jingle:1" action="session-initiate" sid="second-session"/>');
    expect(destinations[1]).toBe("bob@remote.example/recent-message");
    client.sendJingle("bob@remote.example/stale-resource", "third-session", '<jingle xmlns="urn:xmpp:jingle:1" action="session-initiate" sid="third-session"/>');
    expect(destinations[2]).toBe("bob@remote.example/stale-resource");
    client.sendJingle("bob@remote.example/original-initiator", "fourth-session", '<jingle xmlns="urn:xmpp:jingle:1" action="session-accept" sid="fourth-session"/>');
    expect(destinations[3]).toBe("bob@remote.example/original-initiator");
    expect(jingleNodes[3].getAttribute("responder")).toBe("alice@liaot.example/browser");
    expect(jingleNodes[3].hasAttribute("initiator")).toBe(false);
    internal._availableFullJidsByBare.set("bob@remote.example", new Set(["bob@remote.example/live-phone"]));
    client.sendJingle("bob@remote.example", "fifth-session", '<jingle xmlns="urn:xmpp:jingle:1" action="session-initiate" sid="fifth-session"/>');
    expect(destinations[4]).toBe("bob@remote.example/live-phone");
  });

  it("discovers a call-capable resource instead of a stale chat resource", async () => {
    const client = new XmppClient({
      jid: "alice@liaot.example", password: "", wsUrl: "wss://liaot.example/xmpp-websocket", accountId: "alice",
    });
    const internal = client as any;
    internal._connected = true;
    internal._recentMessageFullJidByBare.set("bob@remote.example", "bob@remote.example/stale-chat");
    internal._availableFullJidsByBare.set("bob@remote.example", new Set([
      "bob@remote.example/other-app", "bob@remote.example/conversations",
    ]));
    const queried: string[] = [];
    internal._$iq = (attrs: { to: string }) => {
      queried.push(attrs.to);
      return { c: () => ({ tree: () => document.createElement("iq") }) };
    };
    internal._connection = {
      sendIQ: (_iq: Element, ok: (reply: Element) => void) => {
        const features = queried[queried.length - 1] === "bob@remote.example/conversations"
          ? ["urn:xmpp:jingle:1", "urn:xmpp:jingle:transports:ice-udp:1", "urn:xmpp:jingle:apps:rtp:1", "urn:xmpp:jingle:apps:dtls:0", "urn:xmpp:jingle:apps:rtp:audio"]
          : [];
        ok(new DOMParser().parseFromString(`<iq><query>${features.map((feature) => `<feature var="${feature}"/>`).join("")}</query></iq>`, "text/xml").documentElement);
      },
    };
    expect(await client.findJingleResource("bob@remote.example", ["audio"])).toBe("bob@remote.example/conversations");
    expect(queried).toEqual(["bob@remote.example/conversations"]);
  });

  it("uses a bare-JID call proposal when presence does not reveal a device", async () => {
    const client = new XmppClient({
      jid: "alice@liaot.example", password: "", wsUrl: "wss://liaot.example/xmpp-websocket", accountId: "alice",
    });
    const internal = client as any;
    internal._connected = true;
    const sent: Element[] = [];
    const handlers: Array<(stanza: Element) => boolean> = [];
    const nodes: Element[] = [];
    let current: Element;
    const builder = {
      c(name: string, attrs: Record<string, string>) {
        const node = document.createElementNS(attrs.xmlns ?? current.namespaceURI, name);
        Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
        current.appendChild(node);
        nodes.push(node);
        current = node;
        return this;
      },
      up() { current = current.parentElement ?? current; return this; },
    };
    internal._$msg = (attrs: Record<string, string>) => {
      current = document.createElement("message");
      Object.entries(attrs).forEach(([key, value]) => current.setAttribute(key, value));
      return builder;
    };
    internal._connection = {
      addHandler: (handler: (stanza: Element) => boolean) => { handlers.push(handler); },
      send: (message: object) => sent.push((message as typeof builder) === builder ? nodes[0].parentElement! : message as Element),
    };
    internal._setupHandlers();
    const promise = client.proposeJingleCall("bob@remote.example", ["audio"], "call-123");
    expect(sent).toHaveLength(1);
    expect(sent[0].getAttribute("to")).toBe("bob@remote.example");
    expect(nodes.find((node) => node.localName === "propose")?.getAttribute("id")).toBe("call-123");
    const proceed = new DOMParser().parseFromString(
      '<message from="bob@remote.example/phone"><proceed xmlns="urn:xmpp:jingle-message:0" id="call-123"/></message>',
      "text/xml",
    ).documentElement;
    handlers.forEach((handler) => handler(proceed));
    await expect(promise).resolves.toBe("bob@remote.example/phone");
  });

  it("reports an unsupported call instead of leaving it connecting", () => {
    const client = new XmppClient({
      jid: "alice@liaot.example", password: "", wsUrl: "wss://liaot.example/xmpp-websocket", accountId: "alice",
    });
    const errors: unknown[] = [];
    client.on("jingle.error", (error) => errors.push(error));
    const internal = client as unknown as {
      _connected: boolean;
      _$iq: () => { cnode: (node: Element) => object; tree: () => Element };
      _connection: { sendIQ: (iq: Element, ok: () => void, fail: (error: Element) => void) => void };
    };
    internal._connected = true;
    internal._$iq = () => ({ cnode: () => ({}), tree: () => document.createElement("iq") });
    internal._connection = {
      sendIQ: (_iq, _ok, fail) => fail(new DOMParser().parseFromString(
        '<iq type="error"><error><feature-not-implemented xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>',
        "text/xml",
      ).documentElement),
    };
    client.sendJingle("bob@remote.example/resource", "call-1", '<jingle xmlns="urn:xmpp:jingle:1" action="session-initiate" sid="call-1"/>');
    expect(errors).toEqual([{ accountId: "alice", sid: "call-1", condition: "feature-not-implemented" }]);
  });
});

