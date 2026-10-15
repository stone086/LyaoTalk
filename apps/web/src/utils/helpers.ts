export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function parseJID(jid: string) {
  const [localDomain, resource] = jid.split("/");
  const [local, domain] = localDomain.split("@");
  return { local: local ?? "", domain: domain ?? localDomain, resource };
}

export function normalizeBareJid(jid: string): string {
  return (jid ?? "").split("/")[0].trim().toLowerCase();
}

export function isValidBareJid(jid: string): boolean {
  const normalized = normalizeBareJid(jid);
  const [local, domain, ...rest] = normalized.split("@");
  return Boolean(local && domain && rest.length === 0);
}

export function normalizeValidBareJid(jid: string): string | null {
  const normalized = normalizeBareJid(jid);
  return isValidBareJid(normalized) ? normalized : null;
}

export function getInitials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

export function generateConversationId(accountId: string, peerJid: string): string {
  return `${accountId}:${normalizeBareJid(peerJid)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
}

import { format, isToday, isYesterday, isThisWeek } from "date-fns";

/**
 * Format a message timestamp with context-aware precision:
 * - Same day   → "HH:mm"
 * - This week  → "EEE HH:mm"  (e.g. "Mon 14:30")
 * - Older      → "MM/dd HH:mm"
 *
 * The full ISO timestamp is always available via title/aria-label.
 */
export function formatMsgTime(ts: number): string {
  if (isToday(ts))     return format(ts, "HH:mm");
  if (isYesterday(ts)) return format(ts, `昨天 HH:mm`);
  if (isThisWeek(ts))  return format(ts, "EEE HH:mm");
  return format(ts, "MM/dd HH:mm");
}

export function formatMsgTimeFull(ts: number): string {
  return format(ts, "yyyy-MM-dd HH:mm:ss");
}
