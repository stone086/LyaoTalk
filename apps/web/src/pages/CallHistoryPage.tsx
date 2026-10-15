import { useEffect, useState } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Trash2, Video } from "lucide-react";
import toast from "react-hot-toast";
import Avatar from "@/components/Avatar";
import { api } from "@/services/api";
import { callManager } from "@/services/jingle";
import { useAccountStore } from "@/stores/accountStore";
import { useLanguage } from "@/utils/i18n";

interface CallLog {
  id: string;
  peer_jid: string;
  direction: "incoming" | "outgoing";
  media_types: string;
  status: "answered" | "missed" | "declined" | "failed";
  duration_seconds: number | null;
  started_at: string;
  ended_at: string | null;
}

export default function CallHistoryPage() {
  const { t } = useLanguage();
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<CallLog[]>("/calls/history", { params: { limit: 100 } })
      .then((r) => setLogs(r.data))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, []);

  const handleRedial = async (log: CallLog) => {
    const mediaTypes = log.media_types
      .split(",")
      .filter((m): m is "audio" | "video" => m === "audio" || m === "video");
    if (mediaTypes.length === 0) mediaTypes.push("audio");
    try {
      const accountId = useAccountStore.getState().activeAccountId;
      if (!accountId) return;
      await callManager.startCall(accountId, log.peer_jid, mediaTypes);
    } catch {
      // The call UI surfaces connection failures.
    }
  };

  const handleDelete = async (logId: string) => {
    const previous = logs;
    setLogs((items) => items.filter((item) => item.id !== logId));
    try {
      await api.delete(`/calls/log/${logId}`);
    } catch {
      setLogs(previous);
      toast.error(t("call.deleteFailed"));
    }
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    if (isToday(d)) return format(d, "HH:mm");
    if (isYesterday(d)) return `${t("chat.yesterday")} ${format(d, "HH:mm")}`;
    return format(d, "MM-dd HH:mm");
  };

  return (
    <div className="h-full flex flex-col bg-surface-900">
      <div className="px-5 py-4 border-b border-subtle flex items-center gap-2">
        <Phone size={18} className="text-accent-soft" />
        <h1 className="text-base font-semibold text-surface-50">{t("call.history")}</h1>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-surface-200/40">
          {t("chat.loading")}
        </div>
      ) : logs.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-surface-200/30">
          <Phone size={48} strokeWidth={1} />
          <p className="text-sm">{t("call.noHistory")}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {logs.map((log) => {
            const isMissed = log.status === "missed" || log.status === "declined" || log.status === "failed";
            const isVideo = log.media_types.includes("video");
            const Icon = log.direction === "outgoing" ? PhoneOutgoing : isMissed ? PhoneMissed : PhoneIncoming;
            const duration = formatDuration(log.duration_seconds);

            return (
              <div
                key={log.id}
                className="w-full px-5 py-3.5 hover-surface transition-colors flex items-center gap-3 border-b border-subtle"
              >
                <button
                  onClick={() => void handleRedial(log)}
                  className="min-w-0 flex-1 flex items-center gap-3 text-left"
                >
                  <Avatar name={log.peer_jid} size="md" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-surface-50 truncate">
                      {log.peer_jid.split("@")[0]}
                    </p>
                    <div className="flex items-center gap-1.5 text-xs text-surface-200/50 mt-0.5">
                      <Icon size={12} className={isMissed ? "text-warn" : ""} />
                      {isVideo && <Video size={11} />}
                      <span>{formatTime(log.started_at)}</span>
                      {duration && <span className="text-surface-200/30">· {duration}</span>}
                    </div>
                  </div>
                  <Phone size={14} className="text-accent-soft" />
                </button>
                <button
                  onClick={() => void handleDelete(log.id)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-surface-200/35 hover:text-danger hover:bg-danger/10"
                  title={t("call.delete")}
                  aria-label={t("call.delete")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
