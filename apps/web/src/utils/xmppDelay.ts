const DELAY_NAMESPACE = "urn:xmpp:delay";

/** Archived messages must retain their server timestamp for deletion cutoffs. */
export function parseXmppDelayTimestamp(stanza: Element): number | null {
  const delay = stanza.getElementsByTagNameNS(DELAY_NAMESPACE, "delay").item(0);
  const stamp = delay?.getAttribute("stamp");
  if (!stamp) return null;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}
