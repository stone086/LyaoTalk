import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import App from "./app/App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/globals.css";
import { applyTheme, getStoredTheme } from "./utils/theme";
import { applyConfiguredHistoryRetention } from "./services/historyRetention";
import { initWebVitals } from "./services/webVitals";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000 * 60 * 5, retry: 1 } },
});

async function clearLegacyPwaCachesOnce() {
  const flag = "lyaotalk-sw-reset-2026-04-20";
  if (localStorage.getItem(flag) === "done") return;
  if (!("serviceWorker" in navigator)) {
    localStorage.setItem(flag, "done");
    return;
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Ignore cache cleanup errors.
  } finally {
    localStorage.setItem(flag, "done");
  }
}

applyTheme(getStoredTheme());
document.documentElement.classList.toggle("density-compact", localStorage.getItem("liaot-message-density") === "compact");
applyConfiguredHistoryRetention().catch(() => {});
clearLegacyPwaCachesOnce().catch(() => {});
if ("serviceWorker" in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
  window.addEventListener("focus", () => {
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => {});
  });
}
initWebVitals();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <Toaster
            position="top-right"
            toastOptions={{
              // Use our theme tokens so toasts adapt to dark/light/system mode.
              // CSS vars are populated by globals.css — they shift on .light root.
              style: {
                background: "rgb(var(--popover-surface))",
                color: "rgb(var(--surface-50))",
                border: "1px solid rgb(var(--popover-border))",
                fontSize: "13px",
                boxShadow: "0 8px 24px -4px rgb(0 0 0 / 0.20), 0 4px 8px -2px rgb(0 0 0 / 0.10)",
              },
              success: { iconTheme: { primary: "rgb(var(--success))", secondary: "rgb(var(--popover-surface))" } },
              error:   { iconTheme: { primary: "rgb(var(--danger))", secondary: "rgb(var(--popover-surface))" } },
            }}
          />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
