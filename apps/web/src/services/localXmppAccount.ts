export function localXmppDomain(): string {
  return ((import.meta.env.VITE_XMPP_DOMAIN as string | undefined) || window.location.hostname).trim().toLowerCase();
}

export function isLocalXmppAccount(jid: string): boolean {
  const parts = jid.trim().toLowerCase().split("@");
  return parts.length === 2 && Boolean(parts[0]) && parts[1].split("/")[0] === localXmppDomain();
}

export function requireLocalXmppAccount(jid: string): void {
  if (!isLocalXmppAccount(jid)) {
    throw new Error(`Only ${localXmppDomain()} accounts can sign in to LyaoTalk Web.`);
  }
}
