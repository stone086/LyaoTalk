import { useNavigate, useParams } from "react-router-dom";
import Avatar from "@/components/Avatar";
import { useChatStore } from "@/stores/chatStore";
import { useAccountStore } from "@/stores/accountStore";
import { useRosterStore } from "@/stores/rosterStore";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import { clsx } from "clsx";
import { MessageSquare, Plus, Trash2 } from "lucide-react";
import { useLanguage } from "@/utils/i18n";
import { deleteLocalConversationData } from "@/services/localDb";
import { messagesApi } from "@/services/api";
import toast from "react-hot-toast";
import { isValidBareJid, normalizeBareJid } from "@/utils/helpers";
import { useShallow } from "zustand/react/shallow";

export default function ConversationList({ onStartChat }: { onStartChat?: () => void }) {
  const { lang, t } = useLanguage();
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const conversations = useChatStore(useShallow((s) => Object.values(s.conversations)));
  const composerDrafts = useChatStore((s) => s.composerDrafts);
  const setActive = useChatStore((s) => s.setActiveConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const getContact = useRosterStore((s) => s.getContact);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountJid = normalizeBareJid(accounts.find((a) => a.id === activeAccountId)?.jid ?? "");

  const filtered = conversations
    .filter((c) => c.accountId === activeAccountId)
    .filter((c) => c.type !== "private" || isValidBareJid(c.peerJid))
    .filter((c) => c.type !== "private" || normalizeBareJid(c.peerJid) !== activeAccountJid)
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

  const handleSelect = (id: string) => {
    setActive(id);
    navigate(`/chat/${id}`);
  };

  const handleDelete = async (id: string) => {
    const target = conversations.find((c) => c.id === id);
    if (!target || target.accountId !== activeAccountId) return;
    deleteConversation(id);
    if (conversationId === id) {
      setActive(null);
      navigate("/chat");
    }
    const results = await Promise.allSettled([
      deleteLocalConversationData(id),
      messagesApi.clearConversation(target.accountId, target.peerJid),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      toast.error(t("conv.deleteServerFailed"));
    }
  };

  const getConversationPresence = (accountId: string, peerJid: string, type: string) => {
    if (type !== "private") return "available";
    return getContact(accountId, peerJid)?.presence ?? "unavailable";
  };

  return (
    <div className="flex flex-col h-full">
      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-5 text-center text-surface-200/50">
            <MessageSquare size={30} className="text-accent-soft/70" />
            <span className="text-sm">{t("conv.empty")}</span>
            {onStartChat && (
              <button type="button" onClick={onStartChat} className="btn-primary text-sm inline-flex items-center gap-1.5">
                <Plus size={15} /> {t("conv.startChat")}
              </button>
            )}
          </div>
        ) : (
          filtered.map((conv) => {
            const presence = getConversationPresence(conv.accountId, conv.peerJid, conv.type);
            return (
            <button
              key={conv.id}
              onClick={() => handleSelect(conv.id)}
              className={clsx(
                "conversation-row group w-full flex items-center gap-3 px-3 py-2 transition-all duration-100 text-left",
                conversationId === conv.id
                  ? "bg-accent/10 border-r-2 border-accent"
                  : "hover-surface"
              )}
            >
              <Avatar name={conv.title ?? conv.peerJid ?? "?"} size="sm" presence={presence as any} />

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-surface-50 truncate">
                    {conv.title ?? conv.peerJid}
                  </span>
                  {conv.lastMessageAt && (
                    <span className="text-[10px] text-surface-200/40 flex-shrink-0 ml-1">
                      {formatDistanceToNow(conv.lastMessageAt, {
                        addSuffix: false,
                        locale: lang === "zh-CN" ? zhCN : undefined,
                      })}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-xs text-surface-200/50 truncate">
                    {composerDrafts[conv.id]
                      ? `${t("conv.draft")} ${composerDrafts[conv.id]}`
                      : (conv.lastMessage ?? t("conv.noMessages"))}
                  </span>
                  {conv.unreadCount > 0 && (
                    <span className="badge flex-shrink-0 ml-1">{conv.unreadCount}</span>
                  )}
                </div>
              </div>

              <div
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDelete(conv.id);
                }}
                className="opacity-100 md:opacity-0 md:group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity p-1.5 rounded-lg hover-surface text-surface-200/40 hover:text-danger flex-shrink-0"
                title={t("conv.deleteConversation")}
              >
                <Trash2 size={13} />
              </div>
            </button>
            );
          })
        )}
      </div>
    </div>
  );
}
