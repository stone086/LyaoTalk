import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isValidBareJid, normalizeBareJid } from "@/utils/helpers";

export type SubscriptionState = "both" | "from" | "to" | "none" | "remove";

export interface RosterContact {
  accountId: string;
  jid: string;
  name?: string;
  groups: string[];
  subscription: SubscriptionState;
  pendingIncoming?: boolean;
  presence: "available" | "away" | "dnd" | "xa" | "unavailable";
  statusText?: string;
  avatarUrl?: string;
  lastSeenAt?: number;
  isBlocked: boolean;
  notes?: string;        // private per-user notes (e.g. "Coworker, IT dept, met 2024")
  tags?: string[];       // user-defined tags for organization
}

interface RosterState {
  contacts: Record<string, RosterContact>; // keyed by `${accountId}::${bareJid}`
  setContacts: (contacts: RosterContact[]) => void;
  updatePresence: (accountId: string, jid: string, presence: RosterContact["presence"], statusText?: string) => void;
  upsertContact: (contact: RosterContact) => void;
  removeContact: (accountId: string, jid: string) => void;
  blockContact: (accountId: string, jid: string) => void;
  unblockContact: (accountId: string, jid: string) => void;
  markPendingIncoming: (accountId: string, jid: string) => void;
  setContactNotes: (accountId: string, jid: string, notes: string) => void;
  setContactTags: (accountId: string, jid: string, tags: string[]) => void;
  getContact: (accountId: string, jid: string) => RosterContact | undefined;
  listContacts: (accountId: string) => RosterContact[];
  clearAccountData: (accountId: string) => void;
  pruneInvalidContacts: () => void;
}

function contactKey(accountId: string, jid: string) {
  return `${accountId}::${normalizeBareJid(jid)}`;
}

export const useRosterStore = create<RosterState>()(
  persist(
    (set, get) => ({
      contacts: {},

      setContacts: (contacts) =>
        set({
          contacts: Object.fromEntries(
            contacts
              .map((c) => {
                const jid = normalizeBareJid(c.jid);
                return [contactKey(c.accountId, jid), { ...c, jid }] as const;
              })
              .filter(([, c]) => isValidBareJid(c.jid))
          ),
        }),

      updatePresence: (accountId, jid, presence, statusText) =>
        set((s) => {
          if (!isValidBareJid(jid)) return s;
          const key = contactKey(accountId, jid);
          const existing = s.contacts[key];
          if (!existing) return s;
          return {
            contacts: {
              ...s.contacts,
              [key]: { ...existing, presence, statusText, lastSeenAt: Date.now() },
            },
          };
        }),

      upsertContact: (contact) =>
        set((s) => {
          const jid = normalizeBareJid(contact.jid);
          if (!isValidBareJid(jid)) return s;
          const key = contactKey(contact.accountId, jid);
          const existing = s.contacts[key];
          const nextSubscription = (contact.subscription ?? existing?.subscription ?? "none") as SubscriptionState;
          return {
            contacts: {
              ...s.contacts,
              [key]: {
                ...(existing ?? {}),
                ...contact,
                jid,
                subscription: nextSubscription,
                pendingIncoming:
                  nextSubscription === "none"
                    ? (contact.pendingIncoming ?? existing?.pendingIncoming ?? false)
                    : false,
              },
            },
          };
        }),

      removeContact: (accountId, jid) =>
        set((s) => {
          if (!isValidBareJid(jid)) return s;
          const key = contactKey(accountId, jid);
          const next = { ...s.contacts };
          delete next[key];
          return { contacts: next };
        }),

      blockContact: (accountId, jid) =>
        set((s) => {
          if (!isValidBareJid(jid)) return s;
          const key = contactKey(accountId, jid);
          return {
            contacts: s.contacts[key]
              ? { ...s.contacts, [key]: { ...s.contacts[key], isBlocked: true, pendingIncoming: false } }
              : s.contacts,
          };
        }),

      unblockContact: (accountId, jid) =>
        set((s) => {
          if (!isValidBareJid(jid)) return s;
          const key = contactKey(accountId, jid);
          return {
            contacts: s.contacts[key]
              ? { ...s.contacts, [key]: { ...s.contacts[key], isBlocked: false } }
              : s.contacts,
          };
        }),

      markPendingIncoming: (accountId, jid) =>
        set((s) => {
          if (!isValidBareJid(jid)) return s;
          const key = contactKey(accountId, jid);
          const existing = s.contacts[key];
          if (existing?.subscription && existing.subscription !== "none") return s;
          return {
            contacts: {
              ...s.contacts,
              [key]: {
                ...(existing ?? {}),
                accountId,
                jid: normalizeBareJid(jid),
                groups: existing?.groups ?? [],
                subscription: existing?.subscription ?? "none",
                presence: existing?.presence ?? "unavailable",
                isBlocked: existing?.isBlocked ?? false,
                pendingIncoming: true,
              },
            },
          };
        }),

      setContactNotes: (accountId, jid, notes) =>
        set((s) => {
          if (!isValidBareJid(jid)) return s;
          const key = contactKey(accountId, jid);
          const existing = s.contacts[key];
          if (!existing) return s;
          return {
            contacts: {
              ...s.contacts,
              [key]: { ...existing, notes },
            },
          };
        }),

      setContactTags: (accountId, jid, tags) =>
        set((s) => {
          if (!isValidBareJid(jid)) return s;
          const key = contactKey(accountId, jid);
          const existing = s.contacts[key];
          if (!existing) return s;
          return {
            contacts: {
              ...s.contacts,
              [key]: { ...existing, tags },
            },
          };
        }),

      getContact: (accountId, jid) => {
        if (!isValidBareJid(jid)) return undefined;
        const key = contactKey(accountId, jid);
        return get().contacts[key];
      },

      listContacts: (accountId) =>
        Object.values(get().contacts).filter((c) => c.accountId === accountId && isValidBareJid(c.jid)),

      clearAccountData: (accountId) =>
        set((s) => {
          const next = { ...s.contacts };
          Object.entries(next).forEach(([key, contact]) => {
            if (contact.accountId === accountId) delete next[key];
          });
          return { contacts: next };
        }),

      pruneInvalidContacts: () =>
        set((s) => {
          const next = { ...s.contacts };
          let changed = false;
          Object.entries(next).forEach(([key, contact]) => {
            if (isValidBareJid(contact.jid)) return;
            delete next[key];
            changed = true;
          });
          return changed ? { contacts: next } : s;
        }),
    }),
    {
      name: "liaot-roster",
      onRehydrateStorage: () => (state) => {
        state?.pruneInvalidContacts();
      },
    }
  )
);
