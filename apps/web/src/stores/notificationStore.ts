import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AppNotification {
  id: string;
  type: "message" | "mention" | "system" | "file";
  title: string;
  body: string;
  conversationId?: string;
  accountId?: string;
  read: boolean;
  timestamp: number;
}

interface NotificationState {
  notifications: AppNotification[];
  soundEnabled: boolean;
  browserEnabled: boolean;
  totalUnread: number;

  addNotification: (n: Omit<AppNotification, "id" | "read" | "timestamp">) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  setSoundEnabled: (v: boolean) => void;
  setBrowserEnabled: (v: boolean) => void;
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      notifications: [],
      soundEnabled: true,
      browserEnabled: true,
      totalUnread: 0,

      addNotification: (n) => {
        const notif: AppNotification = {
          ...n,
          id: crypto.randomUUID(),
          read: false,
          timestamp: Date.now(),
        };
        set((s) => ({
          notifications: [notif, ...s.notifications].slice(0, 100),
          totalUnread: s.totalUnread + 1,
        }));

        // Browser notification
        if (get().browserEnabled && "Notification" in window && Notification.permission === "granted") {
          new Notification(n.title, { body: n.body, icon: "/icon-192.png" });
        }

        // Sound — reuse a single AudioContext to avoid hitting browser limit (~6 max)
        if (get().soundEnabled) {
          try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.3);
            // Release the context after the sound finishes to avoid hitting the
            // hard limit of ~6 simultaneous AudioContext instances per tab.
            osc.onended = () => {
              ctx.close().catch(() => {});
            };
          } catch {}
        }
      },

      markRead: (id) =>
        set((s) => ({
          notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
          totalUnread: Math.max(0, s.totalUnread - 1),
        })),

      markAllRead: () =>
        set((s) => ({
          notifications: s.notifications.map((n) => ({ ...n, read: true })),
          totalUnread: 0,
        })),

      clearAll: () => set({ notifications: [], totalUnread: 0 }),
      setSoundEnabled: (v) => set({ soundEnabled: v }),
      setBrowserEnabled: (v) => set({ browserEnabled: v }),
    }),
    { name: "liaot-notifications", partialize: (s) => ({ soundEnabled: s.soundEnabled, browserEnabled: s.browserEnabled }) }
  )
);

export async function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}
