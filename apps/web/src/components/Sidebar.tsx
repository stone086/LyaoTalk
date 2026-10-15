import { NavLink, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  MessageSquare, Settings, Puzzle, Plus, Wifi, WifiOff, Star, Phone, Globe, LogOut, PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import { getAccountPassword, useAccountStore } from "@/stores/accountStore";
import { clsx } from "clsx";
import { useLanguage } from "@/utils/i18n";
import { useShallow } from "zustand/react/shallow";
import { logoutAccount } from "@/services/logoutAccount";
import toast from "react-hot-toast";
import { destroyClient } from "@/services/xmppAdapter";
import { markIntentionalDisconnect, unsuperviseConnection } from "@/services/connectionSupervisor";
import { useReconnectStore } from "@/stores/reconnectStore";
import { useChatStore } from "@/stores/chatStore";

const navItems = [
  { to: "/", icon: MessageSquare, key: "nav.chats", end: true },
  { to: "/starred", icon: Star, key: "nav.starred" },
  { to: "/calls", icon: Phone, key: "nav.calls" },
  { to: "/discovery", icon: Globe, key: "nav.discovery" },
  { to: "/settings", icon: Settings, key: "nav.settings" },
  { to: "/plugins", icon: Puzzle, key: "nav.plugins" },
];

function PresenceBadge({ presence }: { presence: string }) {
  return (
    <span
      className={clsx("presence-dot absolute bottom-0 right-0", {
        available: presence === "available",
        away: presence === "away",
        dnd: presence === "dnd",
        unavailable: !["available", "away", "dnd"].includes(presence),
      })}
    />
  );
}

export default function Sidebar() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const [expanded, setExpanded] = useState(() => localStorage.getItem("liaot-sidebar-expanded") === "true");
  const { accounts, activeId } = useAccountStore(
    useShallow((s) => ({
      accounts: s.accounts,
      activeId: s.activeAccountId,
    }))
  );
  const setActive = useAccountStore((s) => s.setActiveAccount);
  const setConnected = useAccountStore((s) => s.setConnected);
  const setManuallyOffline = useAccountStore((s) => s.setManuallyOffline);
  const setReconnecting = useReconnectStore((s) => s.setReconnecting);
  const unreadByAccount = useChatStore(useShallow((s) => Object.values(s.conversations).reduce<Record<string, number>>((counts, conversation) => {
    counts[conversation.accountId] = (counts[conversation.accountId] ?? 0) + Math.max(0, conversation.unreadCount ?? 0);
    return counts;
  }, {})));
  const activeAccount = accounts.find((a) => a.id === activeId);
  const toggleConnection = () => {
    if (!activeId || !activeAccount) return;
    if (activeAccount.connected) {
      setManuallyOffline(activeId, true);
      markIntentionalDisconnect(activeId);
      destroyClient(activeId);
      unsuperviseConnection(activeId);
      setConnected(activeId, false);
      setReconnecting(activeId, false);
      return;
    }
    if (!browserOnline) {
      toast.error(t("nav.browserOffline"));
      return;
    }
    if (!getAccountPassword(activeId)) {
      toast.error(t("nav.signInToConnect"));
      navigate("/login");
      return;
    }
    setManuallyOffline(activeId, false);
    window.dispatchEvent(new CustomEvent("liaot:reconnect-account", { detail: activeId }));
  };
  const handleLogout = async () => {
    if (!activeId || loggingOut) return;
    setLoggingOut(true);
    try {
      const { remoteRevoked } = await logoutAccount(activeId);
      navigate(useAccountStore.getState().activeAccountId ? "/" : "/login", { replace: true });
      toast[remoteRevoked ? "success" : "error"](remoteRevoked ? t("nav.loggedOut") : t("nav.logoutOffline"));
    } finally {
      setLoggingOut(false);
    }
  };
  const [browserOnline, setBrowserOnline] = useState<boolean>(typeof navigator !== "undefined" ? navigator.onLine : true);

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
    <aside className={clsx(
      "w-14 flex-shrink-0 flex flex-col items-center py-3 gap-2 bg-surface-950 border-r border-subtle transition-[width] duration-200",
      expanded && "md:w-52"
    )}>
      {/* Logo */}
      <div className="mb-2 w-9 h-9 rounded-xl bg-accent/20 flex items-center justify-center
                      border border-accent/30 text-accent font-bold text-sm select-none">
        W3
      </div>

      {/* Account avatars */}
      <div className="flex flex-col gap-2 mb-2">
        {accounts.map((acc) => (
          <button
            key={acc.id}
            onClick={() => setActive(acc.id)}
            className={clsx(
              "relative w-9 h-9 rounded-xl transition-all duration-150",
              acc.id === activeId
                ? "ring-2 ring-accent ring-offset-2 ring-offset-surface-950"
                : "hover:brightness-125"
            )}
            title={acc.jid}
          >
            <div className={clsx("w-full h-full rounded-xl bg-surface-800 flex items-center justify-center text-surface-200 text-xs font-semibold uppercase", acc.id !== activeId && "opacity-60")}>
              {(acc.displayName ?? acc.jid)[0]}
            </div>
            {(unreadByAccount[acc.id] ?? 0) > 0 && (
              <span className="absolute -left-2 -top-2 z-10 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-surface-950" aria-label={`${unreadByAccount[acc.id]} ${t("chat.unread")}`}>
                {unreadByAccount[acc.id] > 99 ? "99+" : unreadByAccount[acc.id]}
              </span>
            )}
            <PresenceBadge presence={acc.connected ? acc.presence : "unavailable"} />
          </button>
        ))}

        {/* Add account */}
        <NavLink
          to="/settings?add=1"
          className="w-9 h-9 rounded-xl border border-dashed border-default
                     flex items-center justify-center text-surface-200/40
                     hover:border-accent/50 hover:text-accent transition-all duration-150"
          title={t("nav.addAccount")}
        >
          <Plus size={14} />
        </NavLink>
      </div>

      <div className="flex-1" />

      {/* Nav icons */}
      <nav className="flex flex-col gap-1 w-full px-1.5">
        {navItems.map(({ to, icon: Icon, key, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            title={t(key)}
            className={({ isActive }) =>
              clsx(
                "w-full flex items-center gap-3 py-2.5 rounded-lg transition-all duration-150",
                expanded ? "md:justify-start md:px-3 justify-center" : "justify-center",
                isActive
                  ? "bg-accent/15 text-accent-soft"
                  : "text-surface-200/50 hover-surface hover:text-surface-200"
              )
            }
          >
            <Icon size={18} />
            {expanded && <span className="hidden md:inline text-sm truncate">{t(key)}</span>}
          </NavLink>
        ))}
      </nav>

      <button
        type="button"
        className="hidden md:flex w-[calc(100%-0.75rem)] items-center justify-center gap-2 rounded-lg py-2 text-surface-200/50 hover-surface"
        onClick={() => setExpanded((value) => {
          localStorage.setItem("liaot-sidebar-expanded", String(!value));
          return !value;
        })}
        aria-label={expanded ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
        title={expanded ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
      >
        {expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        {expanded && <span className="text-xs">{t("nav.collapseSidebar")}</span>}
      </button>

      {/* Connection status */}
      <button
        type="button"
        className="mt-2 flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-surface-800 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!activeAccount}
        onClick={toggleConnection}
        title={activeAccount?.connected ? t("nav.goOffline") : t("nav.goOnline")}
        aria-label={activeAccount?.connected ? t("nav.goOffline") : t("nav.goOnline")}
        aria-pressed={Boolean(activeAccount?.connected)}
      >
        {!browserOnline ? <WifiOff size={14} className="text-danger" /> : activeAccount?.connected
          ? <Wifi size={14} className="text-success" />
          : <WifiOff size={14} className="text-surface-200/30" />
        }
      </button>
      <button
        type="button"
        onClick={() => void handleLogout()}
        disabled={!activeId || loggingOut}
        title={t("nav.logout")}
        aria-label={t("nav.logout")}
        className="w-10 h-10 flex items-center justify-center rounded-lg text-surface-200/50 hover:text-danger hover:bg-danger/10 disabled:opacity-40 transition-colors"
      >
        <LogOut size={18} />
      </button>
    </aside>
  );
}
