// PWA utilities for Lyao Talk

/**
 * Check if app is running in standalone (installed PWA) mode
 */
export function isPWA(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as any).standalone === true
  );
}

/**
 * Prompt user to install PWA (if browser supports it)
 */
let deferredPrompt: any = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome === "accepted";
}

export function canInstall(): boolean {
  return !!deferredPrompt;
}

/**
 * Update document title with unread count
 */
export function updateTabTitle(unreadCount: number, baseTitle = "Lyao Talk") {
  document.title = unreadCount > 0 ? `(${unreadCount}) ${baseTitle}` : baseTitle;
}

/**
 * Set PWA badge count (where supported)
 */
export async function setBadgeCount(count: number) {
  if ("setAppBadge" in navigator) {
    if (count > 0) {
      await (navigator as any).setAppBadge(count);
    } else {
      await (navigator as any).clearAppBadge();
    }
  }
}
