import { useNotificationStore, AppNotification, requestNotificationPermission } from "@/stores/notificationStore";
import { formatDistanceToNow } from "date-fns";
import { Bell, BellOff, Check, Trash2, MessageSquare, AtSign, Settings, File } from "lucide-react";
import { clsx } from "clsx";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "@/utils/i18n";
import { zhCN } from "date-fns/locale";

const typeIcons: Record<AppNotification["type"], React.ReactNode> = {
  message: <MessageSquare size={13} />,
  mention: <AtSign size={13} className="text-accent-soft" />,
  system: <Settings size={13} className="text-surface-200/50" />,
  file: <File size={13} className="text-blue-400" />,
};

export default function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { lang, t } = useLanguage();
  const { notifications, totalUnread, markRead, markAllRead, clearAll, soundEnabled, browserEnabled, setSoundEnabled, setBrowserEnabled } =
    useNotificationStore();
  const navigate = useNavigate();

  const handleClick = (n: AppNotification) => {
    markRead(n.id);
    if (n.conversationId) {
      navigate(`/chat/${n.conversationId}`);
      onClose();
    }
  };

  const enableBrowser = async () => {
    await requestNotificationPermission();
    setBrowserEnabled(true);
  };

  return (
    <div className="absolute right-0 top-12 z-50 w-[min(20rem,calc(100vw-5rem))] glass rounded-xl shadow-2xl border-default
                    animate-fade-in overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-subtle">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-surface-200/60" />
          <span className="text-sm font-semibold text-surface-50">{t("notify.title")}</span>
          {totalUnread > 0 && <span className="badge">{totalUnread}</span>}
        </div>
        <div className="flex items-center gap-1">
          {totalUnread > 0 && (
            <button onClick={markAllRead}
              className="p-1.5 rounded hover-surface text-surface-200/40 hover:text-surface-200"
              title={t("notify.markAllRead")}>
              <Check size={12} />
            </button>
          )}
          <button onClick={clearAll}
            className="p-1.5 rounded hover-surface text-surface-200/40 hover:text-danger"
            title={t("notify.clearAll")}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Settings row */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-subtle bg-surface-900/30">
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-surface-200/50 hover:text-surface-200">
          <input type="checkbox" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)}
            className="w-3.5 h-3.5 accent-[#7c6af7]" />
          {t("notify.sound")}
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-surface-200/50 hover:text-surface-200">
          <input type="checkbox" checked={browserEnabled}
            onChange={(e) => e.target.checked ? enableBrowser() : setBrowserEnabled(false)}
            className="w-3.5 h-3.5 accent-[#7c6af7]" />
          {t("notify.browser")}
        </label>
      </div>

      {/* Notification list */}
      <div className="max-h-72 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="py-8 text-center">
            <BellOff size={20} className="mx-auto mb-2 text-surface-200/20" />
            <p className="text-xs text-surface-200/30">{t("notify.empty")}</p>
          </div>
        ) : (
          notifications.map((n) => (
            <button
              key={n.id}
              onClick={() => handleClick(n)}
              className={clsx(
                "w-full flex items-start gap-3 px-4 py-3 hover-surface transition-colors text-left",
                !n.read && "bg-accent/5"
              )}
            >
              <span className="mt-0.5 flex-shrink-0 text-surface-200/50">{typeIcons[n.type]}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-surface-50 truncate">{n.title}</p>
                <p className="text-xs text-surface-200/50 truncate mt-0.5">{n.body}</p>
                <p className="text-[10px] text-surface-200/25 mt-1">
                  {formatDistanceToNow(n.timestamp, {
                    addSuffix: true,
                    locale: lang === "zh-CN" ? zhCN : undefined,
                  })}
                </p>
              </div>
              {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0 mt-1.5" />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
