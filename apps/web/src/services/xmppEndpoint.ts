const WEBSOCKET_REL = "urn:xmpp:alt-connections:websocket";

export function isLocalXmppJid(jid: string): boolean {
  const domain = jid.split("@")[1]?.split("/")[0]?.toLowerCase();
  const configured = ((import.meta.env.VITE_XMPP_DOMAIN as string | undefined) ?? "").toLowerCase();
  return Boolean(domain && (domain === configured || domain === window.location.hostname.toLowerCase()));
}

export async function resolveXmppWsUrl(jid: string, override?: string): Promise<string> {
  if (override) {
    const url = new URL(override);
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && window.location.protocol === "http:")) {
      throw new Error("XMPP WebSocket URL must use wss://.");
    }
    return url.toString();
  }
  if (isLocalXmppJid(jid)) {
    const configured = (import.meta.env.VITE_XMPP_WS_URL as string | undefined) ?? "";
    const sameOrigin = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/xmpp-websocket`;
    try {
      return configured && new URL(configured).host === window.location.host ? configured : sameOrigin;
    } catch {
      return sameOrigin;
    }
  }
  const domain = jid.split("@")[1]?.split("/")[0]?.toLowerCase();
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) throw new Error("Invalid XMPP account domain.");
  let response: Response;
  try {
    response = await fetch(`https://${domain}/.well-known/host-meta.json`, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(`Cannot discover a WebSocket endpoint for ${domain}. Check server CORS or enter its URL manually.`);
  }
  if (!response.ok) throw new Error(`No WebSocket discovery document for ${domain}. Enter its URL manually.`);
  const document = await response.json() as { links?: Array<{ rel?: string; href?: string }> };
  const href = document.links?.find((link) => link.rel === WEBSOCKET_REL)?.href;
  if (!href) throw new Error(`No XMPP WebSocket endpoint advertised by ${domain}.`);
  const url = new URL(href);
  if (url.protocol !== "wss:") throw new Error(`Insecure XMPP WebSocket endpoint advertised by ${domain}.`);
  return url.toString();
}
