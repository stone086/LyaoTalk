import { useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { messagesApi } from "@/services/api";
import { useChatStore } from "@/stores/chatStore";
import { useAccountStore } from "@/stores/accountStore";
import { useRosterStore } from "@/stores/rosterStore";
import { useGroupStore } from "@/stores/groupStore";
import { debounce } from "@/utils/helpers";
import { searchLocal } from "@/services/searchIndex";
import { Search, MessageSquare, User, Hash, X, Clock, Sparkles } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useLanguage } from "@/utils/i18n";
import { api } from "@/services/api";
import toast from "react-hot-toast";

type ResultType = "message" | "contact" | "room";

interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  subtitle?: string;
  timestamp?: number;
  conversationId?: string;
  messageId?: string;
}

export default function GlobalSearch({ onClose }: { onClose: () => void }) {
  const { lang, t } = useLanguage();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent] = useState<string[]>(JSON.parse(localStorage.getItem("liaot-recent-searches") ?? "[]"));
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const contacts = useRosterStore((s) => (activeAccountId ? s.listContacts(activeAccountId) : []));
  const allRooms = useGroupStore((s) => Object.values(s.rooms));
  const rooms = activeAccountId
    ? allRooms.filter((r) => r.accountId === activeAccountId)
    : [];
  const conversations = useChatStore((s) => Object.values(s.conversations));

  const doSearch = useCallback(
    debounce(async (q: string) => {
      if (!q.trim() || q.length < 2) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const found: SearchResult[] = [];

        contacts
          .filter((c) => c.jid.includes(q) || (c.name ?? "").toLowerCase().includes(q.toLowerCase()))
          .slice(0, 3)
          .forEach((c) =>
            found.push({
              type: "contact",
              id: c.jid,
              title: c.name ?? c.jid.split("@")[0],
              subtitle: c.jid,
            }),
          );

        rooms
          .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()) || r.jid.includes(q))
          .slice(0, 3)
          .forEach((r) =>
            found.push({
              type: "room",
              id: r.jid,
              title: r.name,
              subtitle: r.jid,
            }),
          );

        // KILLER-07: search local IndexedDB index first (instant, offline-capable)
        try {
          const localHits = searchLocal(q, 5);
          for (const m of localHits) {
            const conv = conversations.find((c) => c.id === m.conversationId);
            found.push({
              type: "message",
              id: m.id,
              title: m.body.slice(0, 60),
              subtitle: conv?.title ?? m.senderJid,
              timestamp: m.timestamp,
              conversationId: m.conversationId,
              messageId: m.id,
            });
          }
        } catch {}

        // Fallback to backend search if local index has no hits
        if (found.filter((f) => f.type === "message").length === 0 && activeAccountId) {
          try {
            const msgs = await messagesApi.search(q, activeAccountId);
            msgs.slice(0, 5).forEach((m: any) => {
              const conv = conversations.find((c) => c.id === m.conversation_id);
              found.push({
                type: "message",
                id: m.id,
                title: m.body?.slice(0, 60) ?? "",
                subtitle: conv?.title ?? m.sender_jid,
                timestamp: m.created_at ? new Date(m.created_at).getTime() : undefined,
                conversationId: m.conversation_id,
                messageId: m.id,
              });
            });
          } catch {
            // Ignore backend search errors.
          }
        }

        setResults(found);
      } finally {
        setLoading(false);
      }
    }, 300),
    [contacts, rooms, conversations, activeAccountId],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setQuery(q);
    doSearch(q);
  };

  const handleSelect = (result: SearchResult) => {
    const searches = [query, ...recent.filter((r) => r !== query)].slice(0, 5);
    localStorage.setItem("liaot-recent-searches", JSON.stringify(searches));

    if (result.type === "message" && result.conversationId) {
      const mid = result.messageId ? `?mid=${encodeURIComponent(result.messageId)}` : "";
      navigate(`/chat/${result.conversationId}${mid}`);
    } else if (result.type === "contact" || result.type === "room") {
      const conv = conversations.find((c) => c.peerJid === result.id);
      if (conv) navigate(`/chat/${conv.id}`);
    }
    onClose();
  };

  const icons: Record<ResultType, React.ReactNode> = {
    message: <MessageSquare size={14} className="text-surface-200/50" />,
    contact: <User size={14} className="text-accent-soft" />,
    room: <Hash size={14} className="text-green-400" />,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4 bg-surface-950/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-surface-900 rounded-2xl border-default shadow-2xl overflow-hidden animate-slide-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-subtle">
          <Search size={16} className="text-surface-200/40 flex-shrink-0" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={handleChange}
            placeholder={t("search.placeholder")}
            className="flex-1 bg-transparent text-surface-50 text-sm outline-none placeholder:text-surface-200/30"
          />
          {loading && <span className="w-4 h-4 border border-surface-200/20 border-t-surface-200/60 rounded-full animate-spin flex-shrink-0" />}
          <button onClick={onClose} className="text-surface-200/30 hover:text-surface-200 flex-shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto">
          {query.length === 0 && recent.length > 0 && (
            <div className="p-3">
              <p className="text-[10px] text-surface-200/30 uppercase tracking-wide px-2 mb-1">{t("search.recent")}</p>
              {recent.map((r) => (
                <button key={r} onClick={() => { setQuery(r); doSearch(r); }} className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover-surface text-left">
                  <Clock size={13} className="text-surface-200/30" />
                  <span className="text-sm text-surface-200/70">{r}</span>
                </button>
              ))}
            </div>
          )}

          {query.length > 0 && results.length === 0 && !loading && (
            <div className="py-8 text-center text-sm text-surface-200/30">
              {t("search.noResults")} "{query}"
            </div>
          )}

          {results.length > 0 && (
            <div className="p-2">
              {(["contact", "room", "message"] as ResultType[]).map((type) => {
                const group = results.filter((r) => r.type === type);
                if (!group.length) return null;
                const labels = { contact: t("search.contacts"), room: t("search.rooms"), message: t("search.messages") };
                return (
                  <div key={type}>
                    <p className="text-[10px] text-surface-200/30 uppercase tracking-wide px-2 py-1">{labels[type]}</p>
                    {group.map((result) => (
                      <button key={result.id} onClick={() => handleSelect(result)} className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg hover-surface text-left">
                        <span className="flex-shrink-0">{icons[result.type]}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-surface-50 truncate">{result.title}</p>
                          {result.subtitle && <p className="text-xs text-surface-200/40 truncate">{result.subtitle}</p>}
                        </div>
                        {result.timestamp && (
                          <span className="text-[10px] text-surface-200/30 flex-shrink-0">
                            {formatDistanceToNow(result.timestamp, {
                              addSuffix: true,
                              locale: lang === "zh-CN" ? zhCN : undefined,
                            })}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-subtle flex gap-3 text-[10px] text-surface-200/25">
          <button
            onClick={() => {
              if (!query.trim()) return;
              const loadingId = toast.loading(t("search.askAi"));
              api.post("/ai/rag", { question: query })
                .then((r) => {
                  toast.dismiss(loadingId);
                  const answer = r.data?.answer ?? t("search.noAnswer");
                  toast.success(answer, { duration: 8000 });
                })
                .catch(() => {
                  toast.dismiss(loadingId);
                  toast.error(t("search.aiUnavailable"));
                });
            }}
            className="flex items-center gap-1 text-primary hover:text-primary/80 text-[11px]"
            title={t("search.askAi")}
          >
            <Sparkles className="w-3 h-3" />
            {t("search.askAi")}
          </button>
          <span className="flex-1" />
          <span>{t("search.navigate")}</span>
          <span>{t("search.select")}</span>
          <span>{t("search.close")}</span>
        </div>
      </div>
    </div>
  );
}
