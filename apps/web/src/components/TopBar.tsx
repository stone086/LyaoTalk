import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, Moon, Sun, PanelRight, Lock, Unlock, Phone, Video, MoreVertical } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import GlobalSearch from "@/modules/search/GlobalSearch";
import { applyTheme, getStoredTheme } from "@/utils/theme";
import { useLanguage } from "@/utils/i18n";
import { getGroupOmemoEnabled, getOmemoEnabled, onOmemoEnabledChange, setGroupOmemoEnabled, setOmemoEnabled } from "@/services/omemoSettings";
import { useReconnectStore } from "@/stores/reconnectStore";
import toast from "react-hot-toast";
import { useChatStore } from "@/stores/chatStore";
import { callManager } from "@/services/jingle";
import Avatar from "@/components/Avatar";
import { getClient } from "@/services/xmppAdapter";

interface TopBarProps {
  onToggleRight?: () => void;
  showRightToggle?: boolean;
  onBackToChats?: () => void;
  compact?: boolean;
  conversationId?: string;
}
export default function TopBar({ onToggleRight, showRightToggle, onBackToChats, compact = false, conversationId }: TopBarProps) {
  const { t } = useLanguage();
  const [theme, setTheme] = useState(getStoredTheme());
  const [showSearch, setShowSearch] = useState(false);
  const [showChatMenu, setShowChatMenu] = useState(false);
  const [showCallMenu, setShowCallMenu] = useState(false);
  const [omemoEnabled, setOmemoEnabledState] = useState(getOmemoEnabled());
  const [groupOmemoReady, setGroupOmemoReady] = useState(false);
  const [groupOmemoEnabled, setGroupOmemoEnabledState] = useState(false);
  const dark = useMemo(() => {
    if (theme === "system") return !window.matchMedia("(prefers-color-scheme: light)").matches;
    return theme === "dark";
  }, [theme]);
  const account = useAccountStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const conversation = useChatStore((s) => conversationId ? s.conversations[conversationId] : undefined);
  const reconnectingCount = useReconnectStore((s) => s.reconnectingAccountIds.length);
  const headerRef = useRef<HTMLElement | null>(null);
  const callMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => onOmemoEnabledChange(setOmemoEnabledState), []);
  useEffect(() => {
    setGroupOmemoEnabledState(conversation?.type === "group" && account
      ? getGroupOmemoEnabled(account.id, conversation.peerJid)
      : false);
  }, [account?.id, conversation?.peerJid, conversation?.type]);
  useEffect(() => {
    setGroupOmemoReady(false);
    if (conversation?.type !== "group" || !account?.connected) return;
    let active = true;
    getClient(account.id)?.fetchMucOmemoMembers(conversation.peerJid)
      .then(() => { if (active) setGroupOmemoReady(true); })
      .catch(() => { if (active) setGroupOmemoReady(false); });
    return () => { active = false; };
  }, [account?.id, account?.connected, conversation?.peerJid, conversation?.type]);

  useKeyboardShortcuts({
    "ctrl+k": () => setShowSearch(true),
    "meta+k": () => setShowSearch(true),
    "escape": () => {
      setShowSearch(false);
      setShowChatMenu(false);
      setShowCallMenu(false);
    },
  });

  useEffect(() => {
    if (!showChatMenu && !showCallMenu) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (showCallMenu && !callMenuRef.current?.contains(target)) setShowCallMenu(false);
      if (showChatMenu && !headerRef.current?.contains(target)) setShowChatMenu(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [showChatMenu, showCallMenu]);

  useEffect(() => {
    setShowCallMenu(false);
  }, [conversationId]);

  const startCall = async (mediaTypes: ("audio" | "video")[]) => {
    if (!account || !conversation?.peerJid) return;
    try {
      await callManager.startCall(account.id, conversation.peerJid, mediaTypes);
    } catch (error: any) {
      toast.error(error?.message ?? "Call failed");
    }
  };

  const toggleOmemo = () => {
    if (conversation?.type === "group" && !groupOmemoReady) {
      toast(t("omemo.groupUnavailable"), {
        duration: 3500,
        position: "top-right",
        style: { marginTop: "68px", maxWidth: "min(22rem, calc(100vw - 2rem))" },
      });
      return;
    }
    if (conversation?.type === "group" && account) {
      const next = !groupOmemoEnabled;
      setGroupOmemoEnabled(account.id, conversation.peerJid, next);
      setGroupOmemoEnabledState(next);
      if (next) toast(t("omemo.enabledNotice"), {
        duration: 2200,
        position: "top-right",
        style: { marginTop: "68px", maxWidth: "min(20rem, calc(100vw - 2rem))" },
      });
      return;
    }
    const next = !omemoEnabled;
    setOmemoEnabled(next);
    if (next) toast(t("omemo.enabledNotice"), {
      duration: 2200,
      position: "top-right",
      style: { marginTop: "68px", maxWidth: "min(20rem, calc(100vw - 2rem))" },
    });
    setShowChatMenu(false);
  };

  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    setShowChatMenu(false);
  };

  return (
    <>
      <header ref={headerRef} className="h-12 flex min-w-0 items-center gap-1 border-b border-subtle bg-surface-950/80 px-2 backdrop-blur-sm flex-shrink-0 relative z-20 sm:gap-2 sm:px-3">
        {onBackToChats && (
          <button type="button" onClick={onBackToChats} className="btn-ghost p-2 md:hidden" aria-label={t("chat.backToChats")} title={t("chat.backToChats")}>
            <ArrowLeft size={18} />
          </button>
        )}
        {conversation && !compact ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Avatar name={conversation.title || conversation.peerJid} size="sm" />
            <span className="truncate text-sm font-semibold text-surface-50">{conversation.title || conversation.peerJid}</span>
          </div>
        ) : <button
          onClick={() => setShowSearch(true)}
          className={`flex min-w-0 items-center gap-2 flex-1 px-3 py-1.5 rounded-lg bg-surface-900 border-default text-surface-200/30 hover:border-default transition-colors cursor-text ${compact ? "" : "max-w-xs"}`}
        >
          <Search size={13} />
          <span className="min-w-0 truncate text-xs flex-1 text-left">{t("topbar.searchPlaceholder")}</span>
          <kbd className="hidden sm:inline text-[9px] px-1.5 py-0.5 rounded bg-surface-800 text-surface-200/30 border-default">
            {t("topbar.searchShortcut")}
          </kbd>
        </button>}
        {!compact && !conversation && <div className="hidden flex-1 sm:block" />}
        {!compact && <>
        {conversation && <button type="button" onClick={() => setShowSearch(true)} className="btn-ghost p-2" title={t("topbar.searchPlaceholder")} aria-label={t("topbar.searchPlaceholder")}><Search size={16} /></button>}
        {conversation && <button type="button" onClick={toggleOmemo} className={`btn-ghost p-2 ${conversation.type === "group" ? (groupOmemoReady && groupOmemoEnabled ? "text-success" : "text-warn") : (omemoEnabled ? "text-success" : "text-warn")}`} title={conversation.type === "group" && !groupOmemoReady ? t("omemo.groupUnavailable") : conversation.type === "group" ? (groupOmemoEnabled ? t("omemo.enabled") : t("omemo.disabled")) : omemoEnabled ? t("omemo.enabled") : t("omemo.disabled")} aria-label={conversation.type === "group" && !groupOmemoReady ? t("omemo.groupUnavailable") : conversation.type === "group" ? (groupOmemoEnabled ? t("omemo.enabled") : t("omemo.disabled")) : omemoEnabled ? t("omemo.enabled") : t("omemo.disabled")} aria-pressed={conversation.type === "group" ? groupOmemoReady && groupOmemoEnabled : omemoEnabled}>{conversation.type === "group" ? (groupOmemoReady && groupOmemoEnabled ? <Lock size={16} /> : <Unlock size={16} />) : (omemoEnabled ? <Lock size={16} /> : <Unlock size={16} />)}</button>}
        {conversation && <button type="button" onClick={toggleTheme} className="btn-ghost p-2" title={t("topbar.theme")} aria-label={t("topbar.theme")}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>}
        {conversation?.type === "private" && <div ref={callMenuRef} className="relative">
          <button type="button" onClick={() => { setShowCallMenu((value) => !value); setShowChatMenu(false); }} className="btn-ghost p-2" title={t("chat.callOptions")} aria-label={t("chat.callOptions")} aria-expanded={showCallMenu} aria-haspopup="menu"><Phone size={16} /></button>
          {showCallMenu && <div role="menu" aria-label={t("chat.callOptions")} className="popover-surface absolute right-0 top-full z-30 mt-1 w-40 rounded-xl p-1 text-sm">
            <button type="button" role="menuitem" onClick={() => { setShowCallMenu(false); void startCall(["audio"]); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover-surface"><Phone size={16} />{t("chat.audioCall")}</button>
            <button type="button" role="menuitem" onClick={() => { setShowCallMenu(false); void startCall(["audio", "video"]); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover-surface"><Video size={16} />{t("chat.videoCall")}</button>
          </div>}
        </div>}
        {!conversation && <button onClick={toggleOmemo} className="btn-ghost p-2" title={omemoEnabled ? t("omemo.enabled") : t("omemo.disabled")}>
          {omemoEnabled ? <Lock size={16} /> : <Unlock size={16} />}
        </button>}
        {showRightToggle && !conversation && (
          <button onClick={onToggleRight} className="btn-ghost hidden p-2 sm:block" title={t("topbar.toggleInfo")}>
            <PanelRight size={16} />
          </button>
        )}
        {!conversation && <button onClick={toggleTheme} className="btn-ghost p-2">
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>}
        {conversation && <button type="button" onClick={() => { setShowChatMenu((value) => !value); setShowCallMenu(false); }} className="btn-ghost p-2" title={t("topbar.moreActions")} aria-label={t("topbar.moreActions")} aria-expanded={showChatMenu}><MoreVertical size={17} /></button>}
        {account && !conversation && (
          <div className="hidden md:flex items-center gap-2 px-2 py-1 rounded-lg bg-surface-900 border-default select-none">
            <div className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center text-accent-soft text-xs uppercase font-medium">
              {(account.displayName ?? account.jid)[0]}
            </div>
            <span className="text-surface-200 text-xs max-w-[100px] truncate">
              {account.displayName ?? account.jid.split("@")[0]}
            </span>
            {reconnectingCount > 0 && (
              <span className="text-[10px] text-warn">{`Reconnecting ${reconnectingCount}`}</span>
            )}
          </div>
        )}
        </>}
        {showChatMenu && conversation && <div className="popover-surface absolute right-2 top-full z-30 mt-1 w-48 rounded-xl p-1 text-sm">
          <button type="button" onClick={() => { onToggleRight?.(); setShowChatMenu(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover-surface"><PanelRight size={15} />{t("topbar.toggleInfo")}</button>
        </div>}
      </header>
      {showSearch && <GlobalSearch onClose={() => setShowSearch(false)} />}
    </>
  );
}

