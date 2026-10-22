import { describe, expect, it } from "vitest";
import { parseQrPayload } from "./qrPayload";

const origin = "https://lyaot.2-yc.com";

describe("QR payload handling", () => {
  it("recognizes a same-origin contact QR and an XMPP URI", () => {
    expect(parseQrPayload(`${origin}/?add_contact=Alice%40example.com`, origin))
      .toEqual({ kind: "contact", jid: "alice@example.com" });
    expect(parseQrPayload("xmpp:bob@example.com?subscribe", origin))
      .toEqual({ kind: "contact", jid: "bob@example.com" });
  });

  it("recognizes server invitations without treating outside sites as internal", () => {
    expect(parseQrPayload(`${origin}/login?invite_domain=chat.example.com`, origin))
      .toEqual({ kind: "invite", path: "/login?invite_domain=chat.example.com", domain: "chat.example.com" });
    expect(parseQrPayload("https://elsewhere.example/?add_contact=bob@example.com", origin))
      .toEqual({ kind: "link", url: "https://elsewhere.example/?add_contact=bob@example.com", host: "elsewhere.example" });
  });

  it("never offers an action for script URLs", () => {
    expect(parseQrPayload("javascript:alert(1)", origin)).toEqual({ kind: "text", value: "javascript:alert(1)" });
    expect(parseQrPayload("https://alice@example.com", origin))
      .toEqual({ kind: "link", url: "https://alice@example.com/", host: "example.com" });
  });
});
