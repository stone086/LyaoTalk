import { useEffect, useState } from "react";
import OmemoTrustView from "./OmemoTrustView";
import { useChatStore, Conversation, MessageAttachment } from "@/stores/chatStore";
import { useRosterStore } from "@/stores/rosterStore";
import { useAccountStore } from "@/stores/accountStore";
import { useGroupStore, MucMember } from "@/stores/groupStore";
import { aiApi } from "@/services/api";
import { usePrivateFileUrl } from "@/hooks/usePrivateFileUrl";
import { X, Bot, Users, FileText, Info, Crown, Shield, Loader, Star, Merge } from "lucide-react";
import { useMetaContactStore } from "@/services/metaContacts";
import { clsx } from "clsx";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";
import Avatar from "@/components/Avatar";
import { getClient } from "@/services/xmppAdapter";
import { isTrustedXmppUploadUrl, trustedFileObjectKey } from "@/services/trustedFilesUrl";

type RightTab = "info" | "members" | "files" | "starred" | "ai";

interface RightPanelProps {
  conversationId: string;
  onClose: () => void;
}

function AiSummaryTab({ conversationId }: { conversationId: string }) {
  const { t } = useLanguage();
  const messages = useChatStore((s) => s.messages[conversationId] ?? []);
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<{ summary: string; key_points: string[] } | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const summarize = async () => {
    if (!messages.length) {
      toast(t("right.noMessagesToSummarize"));
      return;
    }
    setLoading(true);
    try {
      const texts = messages.map((m) => m.body).filter(Boolean).slice(-50);
      const res = await aiApi.summarize(texts, conversationId);
      setSummary(res);
    } catch {
      toast.error(t("right.aiUnavailable"));
    } finally {
      setLoading(false);
    }
  };

  const getSmartReplies = async () => {
    const last = messages[messages.length - 1];
    if (!last) return;
    try {
      const res = await aiApi.smartReply(last.body);
      setSuggestions(res.suggestions ?? []);
    } catch {
      toast.error(t("right.aiUnavailable"));
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <button onClick={summarize} disabled={loading} className="btn-primary w-full flex items-center justify-center gap-2 text-sm">
          {loading ? <Loader size={14} className="animate-spin" /> : <Bot size={14} />}
          {loading ? t("right.summarizing") : t("right.summarizeConversation")}
        </button>
        {summary && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="glass rounded-xl p-3">
              <p className="text-xs font-semibold text-surface-200/60 uppercase tracking-wide mb-1">{t("right.summary")}</p>
              <p className="text-sm text-surface-50 leading-relaxed">{summary.summary}</p>
            </div>
            {summary.key_points.length > 0 && (
              <div className="glass rounded-xl p-3">
                <p className="text-xs font-semibold text-surface-200/60 uppercase tracking-wide mb-2">{t("right.keyPoints")}</p>
                <ul className="flex flex-col gap-1">
                  {summary.key_points.map((pt, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-surface-200/80">
                      <span className="text-accent mt-0.5">•</span> {pt}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <button onClick={getSmartReplies} className="btn-ghost w-full flex items-center justify-center gap-2 text-sm border-default">
          <Bot size={14} /> {t("right.smartReplySuggestions")}
        </button>
        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => setComposerDraft(conversationId, s)}
                className="w-full text-left text-xs px-3 py-2 rounded-lg bg-surface-800/50 hover:bg-surface-800 border-default text-surface-200/80"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-surface-200/25 text-center">{t("right.llmTip")}</p>
    </div>
  );
}

function MembersTab({ roomJid }: { roomJid: string }) {
  const { t } = useLanguage();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const members = useGroupStore((s) =>
    activeAccountId ? (s.members[`${activeAccountId}::${roomJid}`] ?? []) : [],
  );

  const roleLabel: Record<MucMember["affiliation"], string> = {
    owner: t("right.owner"),
    admin: t("right.admin"),
    member: t("right.member"),
    none: t("right.guest"),
  };

  if (members.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-surface-200/30">
        <Users size={20} className="mx-auto mb-2 opacity-30" />
        {t("right.joinToSeeMembers")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      {members.map((m) => (
        <div key={m.jid} className="flex items-center gap-3 px-2 py-2 rounded-lg hover-surface">
          <Avatar name={m.nickname} size="xs" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-surface-50 truncate">{m.nickname}</p>
            <p className="text-xs text-surface-200/40">{roleLabel[m.affiliation]}</p>
          </div>
          {m.affiliation === "owner" && <Crown size={12} className="text-yellow-400 flex-shrink-0" />}
          {m.affiliation === "admin" && <Shield size={12} className="text-accent-soft flex-shrink-0" />}
        </div>
      ))}
    </div>
  );
}

function InfoTab({ conversation }: { conversation: Conversation }) {
  const { t } = useLanguage();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const connected = useAccountStore((s) => s.accounts.find((a) => a.id === s.activeAccountId)?.connected ?? false);
  const contact = useRosterStore((s) =>
    activeAccountId ? s.getContact(activeAccountId, conversation.peerJid) : undefined
  );
  const room = useGroupStore((s) =>
    activeAccountId ? s.getRoom(activeAccountId, conversation.peerJid) : undefined,
  );

  useEffect(() => {
    if (conversation.type !== "private" || !activeAccountId || !connected) return;
    const client = getClient(activeAccountId);
    if (!client) return;
    let cancelled = false;
    const jid = conversation.peerJid;
    void client.fetchPepAvatar(jid)
      .then((avatar) => avatar || client.fetchVCardAvatar(jid))
      .then((avatarUrl) => {
        if (cancelled || !avatarUrl) return;
        const latest = useRosterStore.getState().getContact(activeAccountId, jid);
        if (latest && latest.avatarUrl !== avatarUrl) {
          useRosterStore.getState().upsertContact({ ...latest, avatarUrl });
        }
      }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeAccountId, connected, conversation.peerJid, conversation.type]);

  const presenceKnown = connected && contact?.lastSeenAt &&
    (contact.subscription === "both" || contact.subscription === "to");

  return (
    <div className="p-4 flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2 py-2">
        <Avatar name={contact?.name ?? conversation.title ?? conversation.peerJid} src={conversation.type === "private" ? contact?.avatarUrl : undefined} size="xl" />
        <div className="text-center">
          <p className="font-semibold text-surface-50">{contact?.name ?? conversation.title ?? conversation.peerJid}</p>
          <p className="text-xs text-surface-200/40 mt-0.5">{conversation.peerJid}</p>
        </div>
        {contact && (
          <span className={clsx("text-xs px-2 py-0.5 rounded-full", presenceKnown && contact.presence === "available" ? "bg-success/20 text-success" : "bg-surface-800 text-surface-200/50")}>
            {presenceKnown ? contact.presence : t("right.presenceUnknown")}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {presenceKnown && contact?.statusText && (
          <div className="glass rounded-lg p-3">
            <p className="text-xs text-surface-200/40 mb-1">{t("right.status")}</p>
            <p className="text-sm text-surface-50">{contact.statusText}</p>
          </div>
        )}
        {room?.subject && (
          <div className="glass rounded-lg p-3">
            <p className="text-xs text-surface-200/40 mb-1">{t("right.roomSubject")}</p>
            <p className="text-sm text-surface-50">{room.subject}</p>
          </div>
        )}
        <div className="glass rounded-lg p-3">
          <p className="text-xs text-surface-200/40 mb-1">{t("right.type")}</p>
          <p className="text-sm text-surface-50 capitalize">{conversation.type}</p>
        </div>
        {conversation.type === "private" && contact && activeAccountId && (
          <>
            <OmemoTrustButton peerJid={contact.jid} />
            <MergeContactButton accountId={activeAccountId} jid={contact.jid} displayName={contact.name ?? contact.jid.split("@")[0]} />
            <ContactNotesEditor
              key={`${activeAccountId}::${contact.jid}`}
              accountId={activeAccountId}
              jid={contact.jid}
              initialNotes={contact.notes ?? ""}
            />
          </>
        )}
      </div>
    </div>
  );
}

function MergeContactButton({ accountId, jid, displayName }: { accountId: string; jid: string; displayName: string }) {
  const { t } = useLanguage();
  const [showInput, setShowInput] = useState(false);
  const [mergeJid, setMergeJid] = useState("");
  const metaStore = useMetaContactStore();

  // Check if this JID already belongs to a meta-contact
  const existingMetaId = metaStore.jidToMeta[`${accountId}::${jid}`];
  const existingMeta = existingMetaId ? metaStore.metas[existingMetaId] : null;

  const handleMerge = () => {
    const target = mergeJid.trim();
    if (!target || !target.includes("@")) return;
    if (existingMeta) {
      // Add to existing meta-contact
      metaStore.addJidToMeta(existingMeta.id, target);
    } else {
      // Create new meta-contact
      metaStore.addMeta({
        accountId,
        displayName,
        primaryJid: jid,
        jids: [jid, target],
      });
    }
    setMergeJid("");
    setShowInput(false);
  };

  return (
    <div>
      <button
        onClick={() => setShowInput(!showInput)}
        className="glass rounded-lg p-3 flex items-center gap-2 hover-surface text-left w-full"
      >
        <Merge size={14} className="text-accent-soft" />
        <span className="text-sm text-surface-200">
          {existingMeta
            ? `${t("meta.merged")} (${existingMeta.jids.length} JIDs)`
            : t("meta.mergeContact")}
        </span>
      </button>
      {showInput && (
        <div className="mt-2 flex gap-2 px-1">
          <input
            type="text"
            value={mergeJid}
            onChange={(e) => setMergeJid(e.target.value)}
            placeholder="alice@other-server.com"
            className="flex-1 bg-surface-800/40 border-default rounded px-2 py-1 text-xs text-surface-50 placeholder:text-surface-200/30"
            onKeyDown={(e) => e.key === "Enter" && handleMerge()}
          />
          <button onClick={handleMerge} className="text-xs text-primary hover:text-primary/80">
            {t("meta.add")}
          </button>
        </div>
      )}
    </div>
  );
}

function OmemoTrustButton({ peerJid }: { peerJid: string }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="glass rounded-lg p-3 flex items-center gap-2 hover-surface text-left"
      >
        <Shield size={14} className="text-accent-soft" />
        <span className="text-sm text-surface-200">{t("omemo.trustTitle")}</span>
      </button>
      {open && <OmemoTrustView peerJid={peerJid} onClose={() => setOpen(false)} />}
    </>
  );
}

function ContactNotesEditor({
  accountId,
  jid,
  initialNotes,
}: {
  accountId: string;
  jid: string;
  initialNotes: string;
}) {
  const { t } = useLanguage();
  const setContactNotes = useRosterStore((s) => s.setContactNotes);
  const [notes, setNotes] = useState(initialNotes);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setNotes(initialNotes);
  }, [editing, initialNotes]);

  const saveNotes = () => {
    setContactNotes(accountId, jid, notes);
    setEditing(false);
  };

  return (
    <div className="glass rounded-lg p-3 flex flex-col gap-2">
      <p className="text-xs text-surface-200/40">{t("right.notes")}</p>
      {editing ? (
        <>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("right.notesPlaceholder")}
            className="w-full text-sm inset-surface border-default rounded p-2 resize-none text-surface-50"
            rows={3}
            autoFocus
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setNotes(initialNotes); setEditing(false); }}
                    className="text-xs px-2 py-1 rounded hover-surface text-surface-200/60">
              {t("common.cancel")}
            </button>
            <button onClick={saveNotes} className="btn-primary text-xs px-3 py-1">
              {t("common.save")}
            </button>
          </div>
        </>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-left text-sm text-surface-50/80 hover:text-surface-50 transition-colors"
        >
          {notes || <span className="text-surface-200/30 italic">{t("right.notesEmpty")}</span>}
        </button>
      )}

    </div>
  );
}

function FileLink({ file, accountId }: { file: MessageAttachment; accountId?: string | null }) {
  const url = usePrivateFileUrl(file.downloadUrl, accountId);
  return (
    <a href={url ?? undefined} download={file.fileName} target="_blank" rel="noopener noreferrer" aria-disabled={!url}
      className="glass rounded-lg p-3 flex items-center gap-3 hover-surface">
      <FileText size={14} className="text-surface-200/50 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-surface-50 truncate">{file.fileName}</p>
        {file.sizeBytes > 0 && <p className="text-[10px] text-surface-200/40">{(file.sizeBytes / 1024).toFixed(1)} KB</p>}
      </div>
    </a>
  );
}

function FilesTab({ conversationId }: { conversationId: string }) {
  const { t } = useLanguage();
  const messages = useChatStore((s) => s.messages[conversationId] ?? []);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const files = messages.flatMap((m): MessageAttachment[] => {
    if (m.deletedAt) return [];
    if (m.attachments?.length) return m.attachments.filter((a) => Boolean(a.downloadUrl));
    const rawUrl = m.body.trim();
    const objectKey = trustedFileObjectKey(rawUrl, window.location.origin);
    if (!objectKey && !isTrustedXmppUploadUrl(rawUrl, window.location.origin)) return [];
    const name = objectKey?.split("/").pop() || new URL(rawUrl, window.location.origin).pathname.split("/").pop() || "file";
    return [{ id: rawUrl, fileName: name, mimeType: "application/octet-stream", sizeBytes: 0, downloadUrl: rawUrl }];
  });

  const unique = Array.from(
    new Map(files.map((f) => [f.id, f])).values()
  );

  if (unique.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-surface-200/30 mt-4">
        <FileText size={20} className="mx-auto mb-2 opacity-30" />
        {t("right.noFiles")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {unique.map((f) => (
        <FileLink key={f.id} file={f} accountId={activeAccountId} />
      ))}
    </div>
  );
}

function StarredTab({ conversationId }: { conversationId: string }) {
  const { t } = useLanguage();
  const messages = useChatStore((s) => s.messages[conversationId] ?? []);
  const starred = messages
    .filter((m) => Boolean(m.starred))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

  if (starred.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-surface-200/30 mt-4">
        <Star size={20} className="mx-auto mb-2 opacity-30" />
        {t("right.noStarred") === "right.noStarred" ? "No starred messages yet." : t("right.noStarred")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {starred.map((m) => (
        <div key={m.id} className="glass rounded-lg p-3">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[10px] text-surface-200/40 uppercase tracking-wide">
              {m.direction === "out"
                ? (t("right.sent") === "right.sent" ? "Sent" : t("right.sent"))
                : (t("right.received") === "right.received" ? "Received" : t("right.received"))}
            </span>
            <span className="text-[10px] text-surface-200/30">{new Date(m.timestamp).toLocaleString()}</span>
          </div>
          <p className="text-xs text-surface-50 whitespace-pre-wrap break-words">{m.body || "(empty message)"}</p>
        </div>
      ))}
    </div>
  );
}

export default function RightPanel({ conversationId, onClose }: RightPanelProps) {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<RightTab>("info");
  const conversation = useChatStore((s) => s.conversations[conversationId]);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const contactName = useRosterStore((s) => {
    if (!conversation || conversation.type !== "private" || !activeAccountId) return undefined;
    return s.getContact(activeAccountId, conversation.peerJid)?.name;
  });

  useEffect(() => { setActiveTab("info"); }, [conversationId]);

  if (!conversation) return null;

  const tabs: { id: RightTab; icon: React.ReactNode; label: string }[] = [
    { id: "info", icon: <Info size={14} />, label: t("right.info") },
    ...(conversation.type === "group" ? [{ id: "members" as RightTab, icon: <Users size={14} />, label: t("right.members") }] : []),
    { id: "files", icon: <FileText size={14} />, label: t("right.files") },
    {
      id: "starred",
      icon: <Star size={14} />,
      label: t("right.starred") === "right.starred" ? "Starred" : t("right.starred"),
    },
    { id: "ai", icon: <Bot size={14} />, label: t("right.ai") },
  ];

  return (
    <div className="absolute inset-0 z-30 flex h-full w-full flex-col border-l border-subtle bg-surface-900 md:static md:w-72 md:flex-shrink-0 md:bg-surface-900/30">
      <div className="flex items-center justify-between px-3 py-3 border-b border-subtle">
        <span className="text-sm font-semibold text-surface-50 truncate">{contactName ?? conversation.title ?? conversation.peerJid}</span>
        <button onClick={onClose} className="p-1.5 rounded hover-surface text-surface-200/40 hover:text-surface-200" aria-label="Close panel">
          <X size={14} />
        </button>
      </div>

      <div className="flex border-b border-subtle">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              "flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs transition-colors",
              activeTab === tab.id ? "text-accent-soft border-b-2 border-accent" : "text-surface-200/40 hover:text-surface-200",
            )}
            title={tab.label}
          >
            {tab.icon}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === "info" && <InfoTab conversation={conversation} />}
        {activeTab === "members" && <MembersTab roomJid={conversation.peerJid} />}
        {activeTab === "ai" && <AiSummaryTab conversationId={conversationId} />}
        {activeTab === "files" && <FilesTab conversationId={conversationId} />}
        {activeTab === "starred" && <StarredTab conversationId={conversationId} />}
      </div>
    </div>
  );
}
