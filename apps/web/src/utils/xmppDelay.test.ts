// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseXmppDelayTimestamp } from "./xmppDelay";

const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml").documentElement;

describe("XMPP archive timestamps", () => {
  it("reads a namespaced delay even when its namespace is inherited", () => {
    const forwarded = parse('<forwarded xmlns="urn:xmpp:forward:0"><delay xmlns="urn:xmpp:delay" stamp="2026-10-17T02:12:00Z"/><message/></forwarded>');
    expect(parseXmppDelayTimestamp(forwarded)).toBe(Date.parse("2026-10-17T02:12:00Z"));
  });

  it("never substitutes the current time for an undated archive message", () => {
    expect(parseXmppDelayTimestamp(parse('<forwarded xmlns="urn:xmpp:forward:0"><message/></forwarded>'))).toBeNull();
    expect(parseXmppDelayTimestamp(parse('<forwarded><delay xmlns="urn:xmpp:delay" stamp="invalid"/></forwarded>'))).toBeNull();
  });
});
