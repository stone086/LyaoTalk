// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isLocalXmppAccount, requireLocalXmppAccount } from "./localXmppAccount";

describe("web login domain restriction", () => {
  it("accepts a local JID", () => {
    expect(isLocalXmppAccount(`alice@${window.location.hostname}`)).toBe(true);
  });

  it("rejects an external JID before sending credentials", () => {
    expect(isLocalXmppAccount("test1@chat.52nbc.com")).toBe(false);
    expect(() => requireLocalXmppAccount("test1@chat.52nbc.com")).toThrow("Only");
  });
});
