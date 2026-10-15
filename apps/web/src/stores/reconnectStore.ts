import { create } from "zustand";

interface ReconnectState {
  reconnectingAccountIds: string[];
  setReconnecting: (accountId: string, reconnecting: boolean) => void;
}

export const useReconnectStore = create<ReconnectState>((set) => ({
  reconnectingAccountIds: [],
  setReconnecting: (accountId, reconnecting) =>
    set((s) => {
      const has = s.reconnectingAccountIds.includes(accountId);
      if (reconnecting && !has) {
        return { reconnectingAccountIds: [...s.reconnectingAccountIds, accountId] };
      }
      if (!reconnecting && has) {
        return { reconnectingAccountIds: s.reconnectingAccountIds.filter((id) => id !== accountId) };
      }
      return s;
    }),
}));
