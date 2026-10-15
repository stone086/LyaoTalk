export type BrowserFamily = "chrome" | "edge" | "firefox" | "safari" | "samsung" | "unknown";
export type CompatibilitySeverity = "ok" | "warning" | "critical";

export type BrowserCapabilities = {
  family: BrowserFamily;
  isIOS: boolean;
  isSafari: boolean;
  isStandalonePwa: boolean;
  indexedDb: boolean;
  serviceWorker: boolean;
  notification: boolean;
  pushManager: boolean;
  webCrypto: boolean;
  broadcastChannel: boolean;
  online: boolean;
  userAgent: string;
};

export type CompatibilityFinding = {
  id: string;
  severity: CompatibilitySeverity;
  message: string;
  recovery: string;
};

export function detectBrowserFamily(userAgent: string): BrowserFamily {
  const ua = userAgent.toLowerCase();
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("samsungbrowser/")) return "samsung";
  if (ua.includes("firefox/") || ua.includes("fxios/")) return "firefox";
  if ((ua.includes("safari/") && !ua.includes("chrome/") && !ua.includes("chromium/") && !ua.includes("android")) || ua.includes("version/") && ua.includes("safari/")) return "safari";
  if (ua.includes("chrome/") || ua.includes("crios/")) return "chrome";
  return "unknown";
}

function standalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const displayMode = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return displayMode || iosStandalone;
}

export function collectBrowserCapabilities(nav: Navigator = navigator): BrowserCapabilities {
  const userAgent = nav.userAgent || "";
  const family = detectBrowserFamily(userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(userAgent);
  const isSafari = family === "safari";
  const globalObj = globalThis as typeof globalThis & { indexedDB?: IDBFactory; crypto?: Crypto; BroadcastChannel?: typeof BroadcastChannel };
  return {
    family,
    isIOS,
    isSafari,
    isStandalonePwa: standalonePwa(),
    indexedDb: typeof globalObj.indexedDB !== "undefined",
    serviceWorker: "serviceWorker" in nav,
    notification: typeof Notification !== "undefined",
    pushManager: typeof PushManager !== "undefined",
    webCrypto: Boolean(globalObj.crypto?.subtle),
    broadcastChannel: typeof globalObj.BroadcastChannel !== "undefined",
    online: typeof nav.onLine === "boolean" ? nav.onLine : true,
    userAgent,
  };
}

export function evaluateBrowserCompatibility(cap: BrowserCapabilities): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];
  if (!cap.indexedDb) {
    findings.push({
      id: "browser.indexeddb_unavailable",
      severity: "critical",
      message: "IndexedDB is unavailable; OMEMO trust records and local queues cannot persist safely.",
      recovery: "Disable private browsing, allow site storage, then reload before sending sensitive messages.",
    });
  }
  if (!cap.webCrypto) {
    findings.push({
      id: "browser.webcrypto_unavailable",
      severity: "critical",
      message: "WebCrypto is unavailable; encrypted media and OMEMO helpers may fail.",
      recovery: "Use a modern HTTPS browser session. Do not use unsupported embedded webviews.",
    });
  }
  if (!cap.serviceWorker) {
    findings.push({
      id: "browser.serviceworker_unavailable",
      severity: "warning",
      message: "Service Worker is unavailable; offline recovery and PWA caching will be limited.",
      recovery: "Use Chrome, Edge, Firefox, or Safari outside private/incognito mode.",
    });
  }
  if (cap.isIOS && !cap.isStandalonePwa) {
    findings.push({
      id: "browser.ios_push_requires_pwa",
      severity: "warning",
      message: "iOS Web Push requires the site to be installed as a Home Screen PWA.",
      recovery: "Open Safari Share menu, choose Add to Home Screen, then enable notifications from the installed PWA.",
    });
  }
  if (!cap.pushManager || !cap.notification) {
    findings.push({
      id: "browser.push_limited",
      severity: "warning",
      message: "Push notification APIs are incomplete in this browser session.",
      recovery: "Use an installed PWA or a browser with Notification and PushManager support.",
    });
  }
  if (!cap.broadcastChannel) {
    findings.push({
      id: "browser.broadcast_channel_missing",
      severity: "warning",
      message: "BroadcastChannel is unavailable; multi-tab state sync may be limited.",
      recovery: "Avoid multiple active tabs for the same account in this browser.",
    });
  }
  if (!cap.online) {
    findings.push({
      id: "browser.offline",
      severity: "warning",
      message: "The browser reports offline mode; outgoing messages and uploads should remain queued or fail visibly.",
      recovery: "Reconnect the network and verify pending messages are retried or clearly marked failed.",
    });
  }
  if (findings.length === 0) {
    findings.push({
      id: "browser.compatibility_ok",
      severity: "ok",
      message: "No browser compatibility blockers detected.",
      recovery: "Continue normal operation and keep this result in the release evidence.",
    });
  }
  return findings;
}

export type ChaosScenarioId =
  | "network.drop_during_send"
  | "token.expire_during_upload"
  | "prosody.restart_during_session"
  | "minio.unavailable_during_upload"
  | "browser.close_during_send";

export type ChaosScenario = {
  id: ChaosScenarioId;
  title: string;
  expectedRecovery: string;
  evidence: string[];
};

export const CHAOS_SCENARIOS: ChaosScenario[] = [
  {
    id: "network.drop_during_send",
    title: "Network drops while sending a message",
    expectedRecovery: "Message must remain pending, retry after reconnect, or show an explicit failed state; it must not silently disappear.",
    evidence: ["DevTools offline screenshot", "message state before reconnect", "message state after reconnect"],
  },
  {
    id: "token.expire_during_upload",
    title: "Access token expires during file upload",
    expectedRecovery: "Refresh token flow should run once and upload should resume/retry, or the UI should ask for re-login before losing the file selection.",
    evidence: ["401 response", "refresh request", "final upload result"],
  },
  {
    id: "prosody.restart_during_session",
    title: "Prosody restarts while users are online",
    expectedRecovery: "XMPP reconnect supervisor should reconnect with clear status feedback and without duplicate conversations.",
    evidence: ["systemctl restart timestamp", "reconnect logs", "message received after reconnect"],
  },
  {
    id: "minio.unavailable_during_upload",
    title: "MinIO becomes unavailable during upload",
    expectedRecovery: "Upload UI must show a clear storage error and allow the user to retry after service recovery.",
    evidence: ["MinIO stop/start timestamp", "upload error text", "retry result"],
  },
  {
    id: "browser.close_during_send",
    title: "Browser closes while a message is in-flight",
    expectedRecovery: "After reopen, message history must not show a false delivered state; local pending state should be reconciled.",
    evidence: ["before close state", "after reopen state", "server message history"],
  },
];

export function listChaosScenarioIds(): ChaosScenarioId[] {
  return CHAOS_SCENARIOS.map((scenario) => scenario.id);
}
