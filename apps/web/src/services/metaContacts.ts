/**
 * metaContacts.ts - Group multiple JIDs of the same person into one logical contact.
 *
 * Example: Alice has alice@work.com, alice.smith@personal.com, alice@gmail.com
 * The user can merge them into one "Alice" meta-contact. The unified contact:
 *   - Shows aggregated presence (online if ANY JID is online)
 *   - Shows merged conversation list
 *   - Uses one avatar + display name
 *   - Sends messages to a chosen "primary" JID by default
 *
 * Stored in IndexedDB + synced cross-device via PEP private node.
 */

import { useEffect, useState } from "react";
import { create } from "zustand";

export interface MetaContact {
  id: string;                    // generated UUID
  accountId: string;             // owner of this meta-contact group
  displayName: string;
  primaryJid: string;            // the JID to send messages to by default
  jids: string[];                // all JIDs in this group (including primary)
  avatarUrl?: string;
  notes?: string;
}

interface MetaContactStore {
  metas: Record<string, MetaContact>;          // keyed by id
  jidToMeta: Record<string, string>;           // "accountId::jid" -> meta id
  addMeta: (m: Omit<MetaContact, "id">) => string;
  updateMeta: (id: string, patch: Partial<MetaContact>) => void;
  removeMeta: (id: string) => void;
  addJidToMeta: (metaId: string, jid: string) => void;
  removeJidFromMeta: (metaId: string, jid: string) => void;
  setPrimaryJid: (metaId: string, jid: string) => void;
  getMetaForJid: (accountId: string, jid: string) => MetaContact | null;
  loadFromStorage: () => void;
  saveToStorage: () => void;
}

const STORAGE_KEY = "liaot-meta-contacts-v1";

export const useMetaContactStore = create<MetaContactStore>((set, get) => ({
  metas: {},
  jidToMeta: {},

  addMeta: (m) => {
    const id = crypto.randomUUID();
    const meta = { ...m, id };
    set((s) => {
      const newJidToMeta = { ...s.jidToMeta };
      for (const jid of meta.jids) {
        newJidToMeta[`${meta.accountId}::${jid}`] = id;
      }
      return {
        metas: { ...s.metas, [id]: meta },
        jidToMeta: newJidToMeta,
      };
    });
    get().saveToStorage();
    return id;
  },

  updateMeta: (id, patch) => {
    set((s) => {
      const meta = s.metas[id];
      if (!meta) return {};
      return { metas: { ...s.metas, [id]: { ...meta, ...patch } } };
    });
    get().saveToStorage();
  },

  removeMeta: (id) => {
    set((s) => {
      const meta = s.metas[id];
      if (!meta) return {};
      const newMetas = { ...s.metas };
      delete newMetas[id];
      const newJidToMeta = { ...s.jidToMeta };
      for (const jid of meta.jids) {
        delete newJidToMeta[`${meta.accountId}::${jid}`];
      }
      return { metas: newMetas, jidToMeta: newJidToMeta };
    });
    get().saveToStorage();
  },

  addJidToMeta: (metaId, jid) => {
    set((s) => {
      const meta = s.metas[metaId];
      if (!meta || meta.jids.includes(jid)) return {};
      const updated = { ...meta, jids: [...meta.jids, jid] };
      return {
        metas: { ...s.metas, [metaId]: updated },
        jidToMeta: { ...s.jidToMeta, [`${meta.accountId}::${jid}`]: metaId },
      };
    });
    get().saveToStorage();
  },

  removeJidFromMeta: (metaId, jid) => {
    set((s) => {
      const meta = s.metas[metaId];
      if (!meta) return {};
      const newJids = meta.jids.filter((j) => j !== jid);
      if (newJids.length === 0) {
        // No JIDs left - delete the meta-contact entirely
        const newMetas = { ...s.metas };
        delete newMetas[metaId];
        const newJidToMeta = { ...s.jidToMeta };
        delete newJidToMeta[`${meta.accountId}::${jid}`];
        return { metas: newMetas, jidToMeta: newJidToMeta };
      }
      const updated = {
        ...meta,
        jids: newJids,
        primaryJid: meta.primaryJid === jid ? newJids[0] : meta.primaryJid,
      };
      const newJidToMeta = { ...s.jidToMeta };
      delete newJidToMeta[`${meta.accountId}::${jid}`];
      return {
        metas: { ...s.metas, [metaId]: updated },
        jidToMeta: newJidToMeta,
      };
    });
    get().saveToStorage();
  },

  setPrimaryJid: (metaId, jid) => {
    set((s) => {
      const meta = s.metas[metaId];
      if (!meta || !meta.jids.includes(jid)) return {};
      return { metas: { ...s.metas, [metaId]: { ...meta, primaryJid: jid } } };
    });
    get().saveToStorage();
  },

  getMetaForJid: (accountId, jid) => {
    const id = get().jidToMeta[`${accountId}::${jid}`];
    return id ? get().metas[id] ?? null : null;
  },

  loadFromStorage: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { metas: Record<string, MetaContact>; jidToMeta: Record<string, string> };
      set({ metas: data.metas ?? {}, jidToMeta: data.jidToMeta ?? {} });
    } catch { /* ignore */ }
  },

  saveToStorage: () => {
    const { metas, jidToMeta } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ metas, jidToMeta }));
    } catch { /* ignore quota errors */ }
    // Cross-device sync via PEP private node
    void (async () => {
      try {
        const { getCrossDeviceSync } = await import("@/services/crossDeviceSync");
        const sync = getCrossDeviceSync();
        if (sync) await sync.pushMetaContacts(metas, jidToMeta);
      } catch { /* sync degrades gracefully */ }
    })();
  },
}));

// Initialize on module load
if (typeof window !== "undefined") {
  useMetaContactStore.getState().loadFromStorage();
}

/**
 * Hook: get the meta-contact (if any) that wraps the given JID.
 */
export function useMetaForJid(accountId: string | null, jid: string | null): MetaContact | null {
  const meta = useMetaContactStore((s) =>
    accountId && jid ? s.getMetaForJid(accountId, jid) : null
  );
  return meta;
}
