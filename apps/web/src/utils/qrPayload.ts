import { isValidBareJid, normalizeBareJid } from "@/utils/helpers";

export type QrPayload =
  | { kind: "contact"; jid: string }
  | { kind: "invite"; path: string; domain: string }
  | { kind: "link"; url: string; host: string }
  | { kind: "text"; value: string };

export function parseQrPayload(raw: string, origin: string): QrPayload {
  const value = raw.trim();
  const xmppJid = value.match(/^xmpp:([^?]+)(?:\?subscribe)?$/i)?.[1];
  const bareJid = normalizeBareJid(xmppJid ?? value);
  const isContactJid = (jid: string) => /^[^@\s/:?&#]+@[^@\s/:?&#]+$/.test(jid) && isValidBareJid(jid);
  if (isContactJid(bareJid)) return { kind: "contact", jid: bareJid };

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "text", value };
    if (url.origin === origin) {
      const contact = normalizeBareJid(url.searchParams.get("add_contact") ?? "");
      if (url.pathname === "/" && isContactJid(contact)) return { kind: "contact", jid: contact };
      const domain = url.searchParams.get("invite_domain")?.trim() ?? "";
      if (url.pathname === "/login" && domain && /^[a-z0-9.-]+$/i.test(domain)) {
        return { kind: "invite", path: `${url.pathname}${url.search}`, domain };
      }
    }
    return { kind: "link", url: url.toString(), host: url.host };
  } catch {
    return { kind: "text", value };
  }
}
