import { clearLocalMessageHistory, pruneLocalMessagesBefore } from "@/services/localDb";
import { useChatStore } from "@/stores/chatStore";
import { useAccountStore } from "@/stores/accountStore";
import { getUserToken, messagesApi } from "@/services/api";

const HISTORY_RETENTION_DAYS_KEY = "liaot-history-retention-days";
const DEFAULT_RETENTION_DAYS = 1;
const ALLOWED_RETENTION_DAYS = new Set([1, 3, 7]);

export function getStoredHistoryRetentionDays(): number {
  const raw = localStorage.getItem(HISTORY_RETENTION_DAYS_KEY);
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!ALLOWED_RETENTION_DAYS.has(parsed)) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

export function setStoredHistoryRetentionDays(days: number) {
  const safe = ALLOWED_RETENTION_DAYS.has(days) ? days : DEFAULT_RETENTION_DAYS;
  localStorage.setItem(HISTORY_RETENTION_DAYS_KEY, String(safe));
}

export function isMessageWithinRetention(timestamp: number, now = Date.now()): boolean {
  return timestamp > now - getStoredHistoryRetentionDays() * 24 * 60 * 60 * 1000;
}

export async function clearAllHistoryNow() {
  const accounts = useAccountStore.getState().accounts;
  const hasAdminToken = !!sessionStorage.getItem("admin_token");
  if (accounts.length > 0) {
    const clearableAccounts = accounts.filter((account) => hasAdminToken || !!getUserToken(account.id));
    if (clearableAccounts.length > 0) {
      const results = await Promise.allSettled(
        clearableAccounts.map((account) => messagesApi.clearHistory(account.id))
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        // Keep local cleanup usable even if one server-side account call fails.
        console.warn("Some server history clear requests failed", {
          failed: failures.length,
          total: clearableAccounts.length,
        });
      }
    }
  }
  await clearLocalMessageHistory();
  useChatStore.getState().clearAllHistory();
}

export async function applyHistoryRetention(days: number) {
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  await pruneLocalMessagesBefore(cutoff);
  useChatStore.getState().pruneHistoryOlderThan(cutoff);
}

export async function applyConfiguredHistoryRetention() {
  await applyHistoryRetention(getStoredHistoryRetentionDays());
}
