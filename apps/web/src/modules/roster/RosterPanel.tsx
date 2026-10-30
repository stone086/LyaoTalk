import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useRosterStore, RosterContact } from "@/stores/rosterStore";
import { useAccountStore } from "@/stores/accountStore";
import { useChatStore } from "@/stores/chatStore";
import { getClient } from "@/services/xmppAdapter";
import { deleteLocalConversationData } from "@/services/localDb";
import { clsx } from "clsx";
import {
  UserPlus, MoreVertical, MessageSquare,
  Ban, Trash2, ChevronDown, ChevronRight, Users, Unlock, Info,
} from "lucide-react";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";
import { generateConversationId, isValidBareJid, normalizeBareJid } from "@/utils/helpers";
import { safeImageSrc } from "@/utils/urlSafety";
import { useShallow } from "zustand/react/shallow";
import Avatar from "@/components/Avatar";

function PresenceDot({ presence }: { presence: RosterContact["presence"] }) {
  const colors: Record<string, string> = {
    available: "bg-green-400",
    away: "bg-yellow-400",
    dnd: "bg-red-400",
    xa: "bg-orange-400",
    unavailable: "bg-surface-200/30",
  };
  return <span className={clsx("w-2.5 h-2.5 rounded-full border-2 border-surface-900 flex-shrink-0", colors[presence] ?? colors.unavailable)} />;
}

function ContactRow({
  contact,
  onChat,
  onProfile,
}: {
  contact: RosterContact;
  onChat: (jid: string) => void;
  onProfile: (c: RosterContact) => void;
}) {
  const { t } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const blockContact = useRosterStore((s) => s.blockContact);
  const unblockContact = useRosterStore((s) => s.unblockContact);
  const upsertContact = useRosterStore((s) => s.upsertContact);
  const removeContact = useRosterStore((s) => s.removeContact);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  const cancelConversation = (jid: string) => {
    if (!activeAccountId) return;
    const convId = generateConversationId(activeAccountId, normalizeBareJid(jid));
    deleteConversation(convId);
    deleteLocalConversationData(convId).catch(() => {});
  };

  const handleRemove = async () => {
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    try {
      if (!client) throw new Error("XMPP is disconnected");
      await client.removeContact(contact.jid);
      removeContact(activeAccountId, contact.jid);
      toast.success(t("roster.contactRemoved"));
    } catch {
      toast.error(t("roster.removeFailed"));
    }
  };

  const handleAccept = () => {
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    if (contact.isBlocked) {
      client?.unblockJid(contact.jid);
      unblockContact(activeAccountId, contact.jid);
    }
    client?.approveSubscription(contact.jid);
    client?.addContact(contact.jid, contact.name);
    upsertContact({
      ...contact,
      subscription: "both",
      isBlocked: false,
      pendingIncoming: false,
    });
    toast.success(t("roster.accepted"));
  };

  const handleBlock = () => {
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    client?.denySubscription(contact.jid);
    client?.blockJid(contact.jid);
    blockContact(activeAccountId, contact.jid);
    cancelConversation(contact.jid);
    toast.success(t("roster.blockedDone"));
  };

  const handleUnblock = () => {
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    client?.unblockJid(contact.jid);
    unblockContact(activeAccountId, contact.jid);
    toast.success(t("roster.unblockedDone"));
  };

  const handleReject = () => {
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    client?.denySubscription(contact.jid);
    upsertContact({
      ...contact,
      subscription: "none",
      pendingIncoming: false,
    });
    cancelConversation(contact.jid);
    toast.success(t("roster.rejectedDone"));
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [menuOpen]);

  return (
    <div className="relative flex items-center gap-3 px-3 py-2 hover-surface group rounded-lg mx-1 cursor-pointer"
      onClick={() => onChat(contact.jid)}>
      {/* Avatar */}
      <Avatar name={contact.name ?? contact.jid} src={contact.avatarUrl} size="sm" presence={contact.presence} />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-surface-50 truncate font-medium">
          {contact.name ?? contact.jid.split("@")[0]}
        </p>
        <p className="text-xs text-surface-200/40 truncate">
          {contact.pendingIncoming && !contact.isBlocked ? t("roster.pending") : contact.statusText ?? contact.presence}
        </p>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}>
        {contact.pendingIncoming && !contact.isBlocked && (
          <>
            <button onClick={handleAccept}
              className="shrink-0 whitespace-nowrap px-2 py-1 rounded bg-success/20 text-success text-[10px] font-semibold hover:bg-success/30">
              {t("roster.accept")}
            </button>
            <button onClick={handleReject}
              className="shrink-0 whitespace-nowrap px-2 py-1 rounded bg-surface-800/60 text-surface-100 text-[10px] font-semibold hover:bg-surface-800/80">
              {t("roster.reject")}
            </button>
          </>
        )}
        <button onClick={() => onChat(contact.jid)}
          className="p-1.5 rounded hover-surface text-surface-200/50 hover:text-surface-200">
          <MessageSquare size={13} />
        </button>
        <button onClick={() => onProfile(contact)}
          className="p-1.5 rounded hover-surface text-surface-200/50 hover:text-surface-200">
          <Info size={13} />
        </button>
        <div className="relative" ref={menuRef}>
          <button onClick={() => setMenuOpen(!menuOpen)}
            className="p-1.5 rounded hover-surface text-surface-200/50 hover:text-surface-200">
            <MoreVertical size={13} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-6 z-50 glass rounded-lg py-1 w-36 shadow-xl border-default">
              {contact.isBlocked ? (
                <button onClick={() => { handleUnblock(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-success hover-surface">
                  <Unlock size={12} /> {t("roster.unblock")}
                </button>
              ) : (
                <button onClick={() => { handleBlock(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-surface-200 hover-surface">
                  <Ban size={12} /> {t("roster.block")}
                </button>
              )}
              <button onClick={() => { void handleRemove(); setMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-danger hover-surface">
                <Trash2 size={12} /> {t("roster.remove")}
              </button>
            </div>
          )}
        </div>
      </div>

      {contact.isBlocked && (
        <span className="text-[10px] text-danger/70 flex-shrink-0">{t("roster.blocked")}</span>
      )}
    </div>
  );
}

function GroupSection({ name, contacts, onChat, onProfile }: {
  name: string; contacts: RosterContact[]; onChat: (jid: string) => void; onProfile: (c: RosterContact) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div>
      <button onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] font-semibold
                   text-surface-200/40 uppercase tracking-wider hover:text-surface-200/60">
        {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        {name} ({contacts.length})
      </button>
      {!collapsed && contacts.map((c) => (
        <ContactRow key={c.jid} contact={c} onChat={onChat} onProfile={onProfile} />
      ))}
    </div>
  );
}

export default function RosterPanel() {
  const { t } = useLanguage();
  const [showAdd, setShowAdd] = useState(false);
  const [newJid, setNewJid] = useState("");
  const [profileContact, setProfileContact] = useState<RosterContact | null>(null);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const contactMap = useRosterStore(useShallow((s) => s.contacts));
  const upsertContact = useRosterStore((s) => s.upsertContact);
  const pruneInvalidContacts = useRosterStore((s) => s.pruneInvalidContacts);
  const accounts = useAccountStore(useShallow((s) => s.accounts));
  const upsertConversation = useChatStore((s) => s.upsertConversation);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeAccountJid = normalizeBareJid(accounts.find((a) => a.id === activeAccountId)?.jid ?? "");
  const contacts = useMemo(
    () => Object.values(contactMap).filter((c) => c.accountId === activeAccountId && isValidBareJid(c.jid)),
    [contactMap, activeAccountId]
  );

  useEffect(() => {
    pruneInvalidContacts();
  }, [pruneInvalidContacts]);

  const filtered = useMemo(() =>
    contacts.filter((c) =>
      normalizeBareJid(c.jid) !== activeAccountJid
    ), [contacts, activeAccountJid]);

  const grouped = useMemo(() => {
    const groups: Record<string, RosterContact[]> = {
      [t("roster.groupOnline")]: [],
      [t("roster.groupOffline")]: [],
      [t("roster.groupBlocked")]: [],
    };
    filtered.forEach((c) => {
      if (c.isBlocked) {
        groups[t("roster.groupBlocked")].push(c);
        return;
      }
      const g = c.groups[0] ?? (c.presence === "available" ? t("roster.groupOnline") : t("roster.groupOffline"));
      if (!groups[g]) groups[g] = [];
      groups[g].push(c);
    });
    return groups;
  }, [filtered, t]);

  const startChat = (jid: string) => {
    if (!activeAccountId) return;
    const normalizedJid = normalizeBareJid(jid);
    const convId = generateConversationId(activeAccountId, normalizedJid);
    const contact = contacts.find((c) => normalizeBareJid(c.jid) === normalizedJid);
    upsertConversation({
      id: convId,
      accountId: activeAccountId,
      type: "private",
      peerJid: normalizedJid,
      title: contact?.name ?? normalizedJid.split("@")[0],
      unreadCount: 0,
      pinned: false,
    });
    navigate(`/chat/${convId}`);
  };

  const addContact = (rawJid = newJid) => {
    if (!rawJid.trim() || !activeAccountId) return;
    const normalized = normalizeBareJid(rawJid.trim());
    if (!isValidBareJid(normalized)) {
      toast.error(t("roster.invalidJid"));
      setNewJid(normalized);
      setShowAdd(true);
      return;
    }
    if (normalized === activeAccountJid) {
      toast.error(t("roster.cannotAddSelf"));
      return;
    }
    const client = getClient(activeAccountId);
    if (!client?.connected) {
      toast.error(t("chat.notConnected"));
      setNewJid(normalized);
      setShowAdd(true);
      return;
    }
    client.addContact(normalized);
    upsertContact({
      accountId: activeAccountId,
      jid: normalized,
      groups: [],
      subscription: "none",
      presence: "unavailable",
      isBlocked: false,
    });
    toast.success(`${t("roster.added")} ${normalized}`);
    setNewJid("");
    setShowAdd(false);
  };

  useEffect(() => {
    const jid = searchParams.get("add_contact");
    if (!jid || !activeAccountId) return;
    addContact(jid);
    const next = new URLSearchParams(searchParams);
    next.delete("add_contact");
    setSearchParams(next, { replace: true });
  }, [activeAccountId, searchParams, setSearchParams]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-3 border-b border-subtle">
        <h2 className="text-sm font-semibold text-surface-50 flex items-center gap-2">
          <Users size={14} /> {t("roster.title")}
        </h2>
        <button onClick={() => setShowAdd(!showAdd)}
          className="p-1.5 rounded hover-surface text-surface-200/50 hover:text-surface-200">
          <UserPlus size={14} />
        </button>
      </div>

      {showAdd && (
        <div className="px-3 py-2 border-b border-subtle flex gap-2">
          <input value={newJid} onChange={(e) => setNewJid(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addContact()}
            placeholder={t("roster.addJidPlaceholder")}
            className="input-field text-xs flex-1 py-1.5" />
          <button onClick={() => addContact()} className="btn-primary text-xs py-1.5 px-3">{t("roster.add")}</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {Object.entries(grouped).map(([group, list]) =>
          list.length > 0 && (
            <GroupSection key={group} name={group} contacts={list} onChat={startChat} onProfile={setProfileContact} />
          )
        )}
        {contacts.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-surface-200/30">
            <Users size={20} />
            <span className="text-xs">{t("roster.empty")}</span>
          </div>
        )}
      </div>
      {profileContact && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setProfileContact(null)}>
          <div className="w-full max-w-sm rounded-xl border-default bg-surface-900 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-surface-800 overflow-hidden flex items-center justify-center text-lg font-semibold uppercase text-surface-100">
                {(() => {
                  const safeAvatar = safeImageSrc(profileContact.avatarUrl);
                  return safeAvatar
                    ? <img src={safeAvatar} alt={profileContact.name ?? profileContact.jid} className="w-full h-full object-cover" />
                    : (profileContact.name ?? profileContact.jid)[0];
                })()}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-surface-50 truncate">{profileContact.name ?? profileContact.jid.split("@")[0]}</div>
                <div className="text-xs text-surface-200/50 truncate">{profileContact.jid}</div>
              </div>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-surface-200/60">{t("roster.profilePresence")}</span><span className="text-surface-100">{profileContact.presence}</span></div>
              <div className="flex justify-between"><span className="text-surface-200/60">{t("roster.profileSubscription")}</span><span className="text-surface-100">{profileContact.subscription}</span></div>
              <div className="flex justify-between"><span className="text-surface-200/60">{t("roster.profileBlocked")}</span><span className="text-surface-100">{profileContact.isBlocked ? t("common.yes") : t("common.no")}</span></div>
              <div className="flex justify-between"><span className="text-surface-200/60">{t("roster.profileGroups")}</span><span className="text-surface-100">{profileContact.groups.join(", ") || "-"}</span></div>
              <div className="flex justify-between"><span className="text-surface-200/60">{t("roster.profileStatus")}</span><span className="text-surface-100">{profileContact.statusText || "-"}</span></div>
            </div>
            <div className="mt-4 flex justify-end">
              <button className="btn-ghost text-xs" onClick={() => setProfileContact(null)}>{t("common.close")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
