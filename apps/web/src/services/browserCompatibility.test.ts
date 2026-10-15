import { describe, expect, it } from "vitest";
import {
  CHAOS_SCENARIOS,
  detectBrowserFamily,
  evaluateBrowserCompatibility,
  listChaosScenarioIds,
  type BrowserCapabilities,
} from "./browserCompatibility";

const baseCapabilities: BrowserCapabilities = {
  family: "chrome",
  isIOS: false,
  isSafari: false,
  isStandalonePwa: true,
  indexedDb: true,
  serviceWorker: true,
  notification: true,
  pushManager: true,
  webCrypto: true,
  broadcastChannel: true,
  online: true,
  userAgent: "Chrome",
};

describe("browserCompatibility", () => {
  it("detects major browser families from user agents", () => {
    expect(detectBrowserFamily("Mozilla/5.0 Edg/124.0")).toBe("edge");
    expect(detectBrowserFamily("Mozilla/5.0 Firefox/125.0")).toBe("firefox");
    expect(detectBrowserFamily("Mozilla/5.0 Version/17.0 Safari/605.1.15")).toBe("safari");
    expect(detectBrowserFamily("Mozilla/5.0 Chrome/124.0 Safari/537.36")).toBe("chrome");
    expect(detectBrowserFamily("Mozilla/5.0 SamsungBrowser/24.0 Chrome/120.0")).toBe("samsung");
  });

  it("marks healthy modern browsers as ok", () => {
    const findings = evaluateBrowserCompatibility(baseCapabilities);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("browser.compatibility_ok");
  });

  it("raises critical findings for storage and crypto blockers", () => {
    const findings = evaluateBrowserCompatibility({ ...baseCapabilities, indexedDb: false, webCrypto: false });
    expect(findings.map((finding) => finding.id)).toContain("browser.indexeddb_unavailable");
    expect(findings.map((finding) => finding.id)).toContain("browser.webcrypto_unavailable");
    expect(findings.every((finding) => finding.severity !== "ok")).toBe(true);
  });

  it("warns that iOS push requires installed PWA mode", () => {
    const findings = evaluateBrowserCompatibility({ ...baseCapabilities, family: "safari", isIOS: true, isSafari: true, isStandalonePwa: false });
    expect(findings.map((finding) => finding.id)).toContain("browser.ios_push_requires_pwa");
  });

  it("keeps a stable chaos scenario checklist", () => {
    expect(CHAOS_SCENARIOS).toHaveLength(5);
    expect(listChaosScenarioIds()).toEqual([
      "network.drop_during_send",
      "token.expire_during_upload",
      "prosody.restart_during_session",
      "minio.unavailable_during_upload",
      "browser.close_during_send",
    ]);
  });
});
