/**
 * theme.ts — Theme mode management with live OS sync.
 *
 * Modes: "dark" | "light" | "system". When "system" is active, the app
 * follows `prefers-color-scheme` and updates immediately when the OS
 * toggles (e.g. macOS sunset auto-dark, Windows time-based theme switch).
 *
 * Without the live listener, users in "system" mode would see the right
 * theme on initial load and then stay there forever even as the OS swung
 * around them. This module fixes that by attaching a `matchMedia` change
 * listener once and re-resolving the theme whenever the OS preference
 * changes — but only when the stored mode is "system".
 */

export type ThemeMode = "dark" | "light" | "system";

const THEME_KEY = "liaot-theme";

function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode;
}

export function getStoredTheme(): ThemeMode {
  if (typeof localStorage === "undefined") return "dark";
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light" || saved === "system") return saved;
  return "dark";
}

function applyResolvedTheme(resolved: "dark" | "light") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("light", resolved === "light");
  root.classList.toggle("dark", resolved === "dark");
  // Inform the browser chrome (mobile address bar, scrollbars) of the active scheme
  root.style.colorScheme = resolved;
}

export function applyTheme(mode: ThemeMode) {
  applyResolvedTheme(resolveTheme(mode));
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(THEME_KEY, mode);
  }
  // Subscribe to OS changes so "system" mode tracks live.
  ensureSystemListener();
}

// One-time installation of the matchMedia change listener.
let systemListenerInstalled = false;

function ensureSystemListener() {
  if (systemListenerInstalled) return;
  if (typeof window === "undefined") return;
  systemListenerInstalled = true;
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => {
    if (getStoredTheme() === "system") {
      applyResolvedTheme(resolveTheme("system"));
    }
  };
  // Modern API (addEventListener) preferred; fall back to deprecated addListener
  // for older Safari versions still in the wild.
  if (media.addEventListener) {
    media.addEventListener("change", handler);
  } else if ((media as any).addListener) {
    (media as any).addListener(handler);
  }
}
