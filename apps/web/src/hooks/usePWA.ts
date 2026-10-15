import { useEffect } from "react";
import { useNotificationStore } from "@/stores/notificationStore";
import { updateTabTitle, setBadgeCount } from "@/utils/pwa";

/**
 * Syncs unread count to browser tab title and PWA badge.
 * Mount this once at the app root.
 */
export function usePWA() {
  const totalUnread = useNotificationStore((s) => s.totalUnread);

  useEffect(() => {
    updateTabTitle(totalUnread);
    setBadgeCount(totalUnread);
  }, [totalUnread]);
}
