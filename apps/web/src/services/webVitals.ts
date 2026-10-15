interface VitalReport {
  name: "LCP" | "FID" | "CLS" | "INP" | "TTFB";
  value: number;
  rating: "good" | "needs-improvement" | "poor";
  url: string;
  timestamp: number;
}

let buffered: VitalReport[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

export function initWebVitals() {
  if (initialized || typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;
  initialized = true;

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as any;
      const value = last?.renderTime || last?.loadTime;
      if (value) recordVital("LCP", value);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}

  try {
    let clsValue = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        if (!entry.hadRecentInput) clsValue += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        recordVital("CLS", clsValue);
        flushVitals();
      }
    });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      const first = list.getEntries()[0] as any;
      if (first) recordVital("FID", first.processingStart - first.startTime);
    }).observe({ type: "first-input", buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries() as any[];
      const last = entries[entries.length - 1];
      if (last?.duration) recordVital("INP", last.duration);
    }).observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
  } catch {}

  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav) recordVital("TTFB", nav.responseStart - nav.requestStart);
  } catch {}

  window.addEventListener("pagehide", flushVitals);
}

function recordVital(name: VitalReport["name"], value: number) {
  const thresholds: Record<VitalReport["name"], [number, number]> = {
    LCP: [2500, 4000],
    FID: [100, 300],
    CLS: [0.1, 0.25],
    INP: [200, 500],
    TTFB: [800, 1800],
  };
  const [good, poor] = thresholds[name];
  buffered.push({
    name,
    value,
    rating: value < good ? "good" : value < poor ? "needs-improvement" : "poor",
    url: window.location.pathname,
    timestamp: Date.now(),
  });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushVitals, 5000);
}

function flushVitals() {
  if (!buffered.length) return;
  const reports = buffered;
  buffered = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const payload = JSON.stringify({ reports });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/metrics/web-vitals", new Blob([payload], { type: "application/json" }));
    return;
  }
  fetch("/api/metrics/web-vitals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}
