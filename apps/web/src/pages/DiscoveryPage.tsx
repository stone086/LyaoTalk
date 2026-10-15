import { useEffect, useState } from "react";
import { Globe, Server, Users, ArrowRight, Loader } from "lucide-react";
import { api } from "@/services/api";
import { useChatStore } from "@/stores/chatStore";
import { useAccountStore } from "@/stores/accountStore";
import { useLanguage } from "@/utils/i18n";
import toast from "react-hot-toast";

interface PublicGroup {
  jid: string;
  name: string;
  description?: string;
  occupants?: number;
}

interface ServerHealth {
  uptime_seconds: number;
  version: string;
  accounts: number;
  latency_ms: number;
}

export default function DiscoveryPage() {
  const { t } = useLanguage();
  const [groups, setGroups] = useState<PublicGroup[]>([]);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  useEffect(() => {
    Promise.all([
      api.get<PublicGroup[]>("/discovery/groups").then((r) => setGroups(r.data)).catch(() => {}),
      api.get<ServerHealth>("/discovery/health").then((r) => setHealth(r.data)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const handleJoinGroup = (group: PublicGroup) => {
    if (!activeAccountId) return;
    // Create a group conversation entry so user can start chatting
    useChatStore.getState().upsertConversation({
      id: `group-${group.jid}`,
      accountId: activeAccountId,
      type: "group",
      peerJid: group.jid,
      title: group.name,
      unreadCount: 0,
      lastMessage: "",
      lastMessageAt: Date.now(),
      pinned: false,
    });
    toast.success(`Joined ${group.name}`);
  };

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader className="w-5 h-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold mb-6 flex items-center gap-2">
        <Globe className="w-5 h-5" />
        {t("discovery.title")}
      </h1>

      {/* Server health badge */}
      {health && (
        <div className="bg-surface-50 rounded-lg p-4 mb-6 flex flex-wrap items-center gap-2 text-sm">
          <Server className="w-4 h-4 text-green-600 shrink-0" />
          <span>v{health.version}</span>
          <span className="text-surface-400">·</span>
          <span>{t("discovery.uptime")}: {formatUptime(health.uptime_seconds)}</span>
          <span className="text-surface-400">·</span>
          <span>{health.accounts} {t("discovery.users")}</span>
          <span className="text-surface-400">·</span>
          <span>{health.latency_ms}ms</span>
        </div>
      )}

      {/* Public groups */}
      <h2 className="text-sm font-medium text-surface-500 uppercase tracking-wider mb-3">
        {t("discovery.publicGroups")}
      </h2>
      {groups.length === 0 ? (
        <p className="text-surface-400 text-sm">{t("discovery.noGroups")}</p>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <div
              key={group.jid}
              className="flex items-center gap-3 p-3 rounded-lg border border-surface-200 hover:bg-surface-50 transition-colors"
            >
              <Users className="w-5 h-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{group.name}</div>
                <div className="text-xs text-surface-400 truncate">{group.jid}</div>
                {group.description && (
                  <div className="text-xs text-surface-500 mt-0.5 truncate">{group.description}</div>
                )}
              </div>
              {group.occupants != null && (
                <span className="text-xs text-surface-400">{group.occupants}</span>
              )}
              <button
                onClick={() => handleJoinGroup(group)}
                className="text-primary hover:text-primary/80 p-1"
                title={t("discovery.join")}
              >
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
