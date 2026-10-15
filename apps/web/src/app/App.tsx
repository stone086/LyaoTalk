import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAccountStore } from "@/stores/accountStore";
import { useChatStore } from "@/stores/chatStore";
import { useXmppReconnect } from "@/hooks/useXmppReconnect";
import { usePWA } from "@/hooks/usePWA";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import MainLayout from "@/layouts/MainLayout";
import LoginPage from "@/pages/LoginPage";
import ChatPage from "@/pages/ChatPage";
import SettingsPage from "@/pages/SettingsPage";
import AdminPage from "@/pages/AdminPage";
import PluginsPage from "@/pages/PluginsPage";
import StarredPage from "@/pages/StarredPage";
import CallHistoryPage from "@/pages/CallHistoryPage";
import DiscoveryPage from "@/pages/DiscoveryPage";
import { useLanguage } from "@/utils/i18n";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const accounts = useAccountStore((s) => s.accounts);
  const activeId = useAccountStore((s) => s.activeAccountId);
  if (!activeId || accounts.length === 0) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppInner() {
  useXmppReconnect();
  usePWA();
  const mergeDuplicatePrivateConversations = useChatStore((s) => s.mergeDuplicatePrivateConversations);
  const [browserOnline, setBrowserOnline] = useState<boolean>(typeof navigator !== "undefined" ? navigator.onLine : true);
  const { t } = useLanguage();

  useEffect(() => {
    mergeDuplicatePrivateConversations();
  }, [mergeDuplicatePrivateConversations]);

  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<AuthGuard><MainLayout /></AuthGuard>}>
          <Route
            index
            element={
              <ErrorBoundary>
                <ChatPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="chat/:conversationId?"
            element={
              <ErrorBoundary>
                <ChatPage />
              </ErrorBoundary>
            }
          />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="plugins" element={<PluginsPage />} />
          <Route path="starred" element={<StarredPage />} />
          <Route path="calls" element={<CallHistoryPage />} />
          <Route path="discovery" element={<DiscoveryPage />} />
          <Route path="admin" element={<AdminPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!browserOnline && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-danger/90 text-white text-xs text-center py-1.5">
          {t("app.offline")}
        </div>
      )}
    </>
  );
}

export default function App() {
  return <AppInner />;
}
