import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PresenceType = "available" | "away" | "dnd" | "unavailable";

export interface XmppAccount {
  id: string;
  jid: string;
  domain: string;
  password?: string;
  is_enabled?: boolean;
  displayName?: string;
  avatarUrl?: string;
  presence: PresenceType;
  statusText?: string;
  connected: boolean;
  manuallyOffline?: boolean;
}

interface AccountState {
  accounts: XmppAccount[];
  activeAccountId: string | null;
  addAccount: (account: Omit<XmppAccount, "presence" | "connected">) => void;
  removeAccount: (id: string) => void;
  setActiveAccount: (id: string) => void;
  updatePresence: (id: string, presence: PresenceType) => void;
  updateStatusText: (id: string, statusText: string) => void;
  updateAvatar: (id: string, avatarUrl: string) => void;
  setConnected: (id: string, connected: boolean) => void;
  setManuallyOffline: (id: string, offline: boolean) => void;
}

export function normalizeAccountJid(jid: string): string {
  return jid.split("/")[0].trim().toLowerCase();
}

function dedupeAccounts(accounts: XmppAccount[]): XmppAccount[] {
  const byJid = new Map<string, XmppAccount>();
  for (const account of accounts) {
    const key = normalizeAccountJid(account.jid);
    if (!key) continue;
    const existing = byJid.get(key);
    byJid.set(key, {
      ...existing,
      ...account,
      jid: key,
      domain: key.split("@")[1] ?? account.domain,
      presence: account.presence ?? existing?.presence ?? "available",
      statusText: account.statusText ?? existing?.statusText,
      connected: account.connected ?? existing?.connected ?? false,
      manuallyOffline: account.manuallyOffline ?? existing?.manuallyOffline ?? false,
      is_enabled: account.is_enabled ?? existing?.is_enabled ?? true,
    });
  }
  return Array.from(byJid.values());
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set) => ({
      accounts: [],
      activeAccountId: null,

      addAccount: (account) =>
        set((s) => {
          const jid = normalizeAccountJid(account.jid);
          const existing = s.accounts.find((a) => normalizeAccountJid(a.jid) === jid);
          const nextId = account.id || existing?.id || crypto.randomUUID();
          if (existing && nextId && existing.id !== nextId) {
            migrateSessionValue(PASSWORD_KEY_PREFIX, existing.id, nextId);
            migrateSessionValue(USER_TOKEN_KEY_PREFIX, existing.id, nextId);
            migrateSessionValue(USER_REFRESH_KEY_PREFIX, existing.id, nextId);
          }
          const nextAccount: XmppAccount = {
            id: nextId,
            jid,
            domain: jid.split("@")[1] ?? account.domain,
            displayName: account.displayName ?? existing?.displayName,
            avatarUrl: account.avatarUrl ?? existing?.avatarUrl,
            is_enabled: account.is_enabled ?? existing?.is_enabled ?? true,
            presence: existing?.presence ?? "available",
            statusText: existing?.statusText,
            connected: existing?.connected ?? false,
            manuallyOffline: existing?.manuallyOffline ?? false,
          };
          const accounts = dedupeAccounts([
            ...s.accounts.filter((a) => normalizeAccountJid(a.jid) !== jid),
            nextAccount,
          ]);
          return {
            accounts,
            activeAccountId:
              s.activeAccountId === existing?.id
                ? nextAccount.id
                : s.activeAccountId ?? nextAccount.id,
          };
        }),

      removeAccount: (id) =>
        set((s) => {
          sessionStorage.removeItem(`${PASSWORD_KEY_PREFIX}${id}`);
          sessionStorage.removeItem(`${USER_TOKEN_KEY_PREFIX}${id}`);
          sessionStorage.removeItem(`${USER_REFRESH_KEY_PREFIX}${id}`);
          return {
            accounts: s.accounts.filter((a) => a.id !== id),
            activeAccountId:
              s.activeAccountId === id
                ? s.accounts.find((a) => a.id !== id)?.id ?? null
                : s.activeAccountId,
          };
        }),

      setActiveAccount: (id) => set({ activeAccountId: id }),

      updatePresence: (id, presence) =>
        set((s) => ({
          accounts: s.accounts.map((a) => (a.id === id ? { ...a, presence } : a)),
        })),
      updateStatusText: (id, statusText) =>
        set((s) => ({
          accounts: s.accounts.map((a) => (a.id === id ? { ...a, statusText } : a)),
        })),
      updateAvatar: (id, avatarUrl) =>
        set((s) => ({
          accounts: s.accounts.map((a) => (a.id === id ? { ...a, avatarUrl } : a)),
        })),

      setConnected: (id, connected) =>
        set((s) => ({
          accounts: s.accounts.map((a) => (a.id === id ? { ...a, connected } : a)),
        })),
      setManuallyOffline: (id, offline) =>
        set((s) => ({
          accounts: s.accounts.map((a) => (a.id === id ? { ...a, manuallyOffline: offline, connected: offline ? false : a.connected } : a)),
        })),
    }),
    {
      name: "liaot-accounts",
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AccountState> | undefined;
        // A socket cannot survive a page reload. Never restore its old
        // connected flag from localStorage while reconnect is still pending.
        const accounts = dedupeAccounts(persisted?.accounts ?? []).map((account) => ({
          ...account,
          connected: false,
        }));
        const hasActive = accounts.some((a) => a.id === persisted?.activeAccountId);
        return {
          ...currentState,
          ...persisted,
          accounts,
          activeAccountId: hasActive ? persisted?.activeAccountId ?? null : accounts[0]?.id ?? null,
        };
      },
      partialize: (state) => ({
        accounts: state.accounts.map(({ password, ...rest }) => ({ ...rest, connected: false })),
        activeAccountId: state.activeAccountId,
      }),
    }
  )
);

const PASSWORD_KEY_PREFIX = "liaot-account-password:";
const USER_TOKEN_KEY_PREFIX = "liaot-user-token:";
const USER_REFRESH_KEY_PREFIX = "liaot-user-refresh:";

function migrateSessionValue(prefix: string, fromId: string, toId: string) {
  const fromKey = `${prefix}${fromId}`;
  const value = sessionStorage.getItem(fromKey);
  if (value && !sessionStorage.getItem(`${prefix}${toId}`)) {
    sessionStorage.setItem(`${prefix}${toId}`, value);
  }
  sessionStorage.removeItem(fromKey);
}

export function setAccountPassword(accountId: string, password: string) {
  sessionStorage.setItem(`${PASSWORD_KEY_PREFIX}${accountId}`, password);
}

export function getAccountPassword(accountId: string): string | null {
  return sessionStorage.getItem(`${PASSWORD_KEY_PREFIX}${accountId}`);
}

export function clearAccountPassword(accountId: string) {
  sessionStorage.removeItem(`${PASSWORD_KEY_PREFIX}${accountId}`);
}
