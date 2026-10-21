import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { useChatStore, ChatMessage, MessageAttachment } from "@/stores/chatStore";
import { useAccountStore } from "@/stores/accountStore";
import { useRosterStore } from "@/stores/rosterStore";
import { useGroupStore } from "@/stores/groupStore";
import { getClient } from "@/services/xmppAdapter";
import { useTypingIndicator } from "@/hooks/useTypingIndicator";
import { useMAM } from "@/hooks/useMAM";
import { UploadedFile, ImagePreview, FileCard } from "@/modules/media/FileUpload";
import Avatar from "@/components/Avatar";
import LinkPreviewCard, { extractFirstUrl } from "@/components/LinkPreviewCard";
import VoiceRecorder from "@/components/VoiceRecorder";
import AesgcmMedia from "@/components/AesgcmMedia";
import VirtualMessageList from "@/modules/chat/VirtualMessageList";
import { cacheMessages, deleteLocalMessage, getDraft, getLocalMessages, saveDraft } from "@/services/localDb";
import { getChatToolbarActions } from "@/plugins/host";
import type { ChatToolbarAction } from "@/plugins/sdk";
import { format, isSameDay } from "date-fns";
import { formatMsgTime, formatMsgTimeFull } from "@/utils/helpers";
import { clsx } from "clsx";
import { Send, Plus, X, ChevronDown, CornerUpLeft, Loader, Smile, MoreVertical, Star, Pencil, Forward, Trash2, Lock, LockOpen, Check, CheckCheck, Clock, UserPlus, Mic, Image as ImageIcon, FileText, MapPin, UserRound, Camera, ClipboardPaste } from "lucide-react";
import { processSlashCommand } from "@/services/slashCommands";
import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import MediaCapture from "./MediaCapture";
import LocationPicker from "./LocationPicker";
import LocationViewer from "./LocationViewer";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";
import { attachmentsApi, privateFileBlob } from "@/services/api";
import { encryptForAesgcm, parseAesgcmUrl, toAesgcmUrl } from "@/services/aesgcmMedia";
import { usePrivateFileUrl } from "@/hooks/usePrivateFileUrl";
import { isTrustedXmppUploadUrl, trustedFileObjectKey } from "@/services/trustedFilesUrl";
import { encryptOmemoEnvelopeForPeer } from "@/services/e2ee";
import { encryptGroupOmemoMessage, tryLibsignalEncrypt } from "@/services/xmppBridge";
import { getGroupOmemoEnabled, getOmemoEnabled } from "@/services/omemoSettings";
import { applyMessageRetraction } from "@/services/messageRetraction";
import { removeFromIndex } from "@/services/searchIndex";
import { parseSharedLocation } from "@/utils/geoUri";

function parseAesgcmMediaLink(raw?: string): { href: string; fileName: string; isAudio: boolean } | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text.startsWith("aesgcm://")) return null;
  const parts = parseAesgcmUrl(text);
  if (!parts) return null;
  const href = parts.ciphertextUrl;
  const encodedName = parts.fileName;
  let fileName = encodedName;
  try { fileName = decodeURIComponent(encodedName); } catch { /* malformed peer URL */ }
  const lower = fileName.toLowerCase();
  const isAudio = lower.endsWith(".m4a") || lower.endsWith(".mp3") || lower.endsWith(".ogg") || lower.endsWith(".wav") || lower.endsWith(".weba");
  return { href, fileName, isAudio };
}

async function publishFederatedMedia(file: Blob, name: string, accountId: string): Promise<string> {
  const { ciphertext, fragment } = await encryptForAesgcm(file);
  const encrypted = new File([ciphertext], name, { type: "application/octet-stream" });
  const upload = await attachmentsApi.upload(encrypted, undefined, accountId);
  const { url } = await attachmentsApi.publishEncrypted(upload.id, accountId);
  return toAesgcmUrl(url, fragment);
}

function DateDivider({ date, todayLabel, yesterdayLabel }: { date: number; todayLabel: string; yesterdayLabel: string }) {
  const label = isSameDay(date, Date.now())
    ? todayLabel
    : isSameDay(date, Date.now() - 86400000)
      ? yesterdayLabel
      : format(date, "yyyy-MM-dd");
  return (
    <div className="flex items-center gap-3 py-2 my-1">
      <div className="flex-1 h-px bg-surface-800/40" />
      <span className="text-[10px] text-surface-200/30 px-2 py-0.5 rounded-full bg-surface-900">{label}</span>
      <div className="flex-1 h-px bg-surface-800/40" />
    </div>
  );
}

function AttachmentView({
  attachment,
  accountId,
  onOpenImage,
}: {
  attachment: MessageAttachment;
  accountId?: string | null;
  onOpenImage: (src: string, alt: string) => void;
}) {
  const url = usePrivateFileUrl(attachment.downloadUrl, accountId);
  return (
    <div className="mt-2">
      {!url ? (
        <span className="text-xs text-surface-200/50">{attachment.fileName}</span>
      ) : attachment.mimeType.startsWith("image/") ? (
        <ImagePreview src={url} alt={attachment.fileName} onClick={() => onOpenImage(url, attachment.fileName)} />
      ) : (
        <FileCard name={attachment.fileName} mimeType={attachment.mimeType} sizeBytes={attachment.sizeBytes} downloadUrl={url} />
      )}
    </div>
  );
}

function ReceivedFileLink({ rawUrl, accountId, onOpenImage }: {
  rawUrl: string;
  accountId?: string | null;
  onOpenImage: (src: string, alt: string) => void;
}) {
  const objectKey = trustedFileObjectKey(rawUrl, window.location.origin);
  const name = objectKey?.split("/").pop() || new URL(rawUrl, window.location.origin).pathname.split("/").pop() || "file";
  const extension = name.split(".").pop()?.toLowerCase();
  const mimeType = extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : "application/octet-stream";
  return <AttachmentView attachment={{ id: objectKey || rawUrl, fileName: name, mimeType, sizeBytes: 0, downloadUrl: rawUrl }} accountId={accountId} onOpenImage={onOpenImage} />;
}

function MessageBubble({
  msg,
  replyPreview,
  replySender,
  isOwn,
  onReply,
  onOpenImage,
  onOpenLocation,
  onRetry,
  onEdit,
  onForward,
  onDelete,
  onToggleStar,
  onReact,
  sentLabel,
  readLabel,
  activeAccountId,
  avatarSrc,
}: {
  msg: ChatMessage;
  replyPreview?: string;
  replySender?: string;
  isOwn: boolean;
  onReply: (m: ChatMessage) => void;
  onOpenImage: (src: string, alt: string) => void;
  onOpenLocation: (latitude: number, longitude: number) => void;
  onRetry: (m: ChatMessage) => void;
  onEdit: (m: ChatMessage) => void;
  onForward: (m: ChatMessage) => void;
  onDelete: (m: ChatMessage) => void;
  onToggleStar: (m: ChatMessage) => void;
  onReact: (m: ChatMessage, emoji: string) => void;
  sentLabel: string;
  readLabel: string;
  activeAccountId?: string | null;
  avatarSrc?: string;
}) {
  const { t } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
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
  useEffect(() => {
    if (!showReactionPicker) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowReactionPicker(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showReactionPicker]);
  return (
    <div
      className={clsx("flex gap-2 group", isOwn ? "flex-row-reverse" : "flex-row")}
    >
      {!isOwn && (
        <Avatar name={msg.senderJid} src={avatarSrc} size="xs" className="mt-auto mb-1" />
      )}
      <div className={clsx("flex min-w-0 max-w-[86%] flex-col gap-1 sm:max-w-[76%]", isOwn ? "items-end" : "items-start")}>
        {!isOwn && <span className="text-[10px] text-surface-200/40 px-1">{msg.senderJid.split("@")[0]}</span>}
        <div
          className={clsx(
            isOwn ? "msg-bubble-out" : "msg-bubble-in",
            msg.encrypted === true ? "msg-bubble-encrypted" : msg.encrypted === false ? "msg-bubble-plain" : null
          )}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!msg.deletedAt) setMenuOpen(true);
          }}
          onTouchStart={(e) => {
            if (msg.deletedAt) return;
            // long-press detection (500ms)
            const target = e.currentTarget;
            const timer = window.setTimeout(() => setMenuOpen(true), 500);
            const cancel = () => { window.clearTimeout(timer); };
            target.addEventListener("touchend", cancel, { once: true });
            target.addEventListener("touchmove", cancel, { once: true });
          }}
        >
          {!msg.deletedAt && msg.replyToId && (
            <div className="mb-2 px-2 py-1 rounded-md border-l-2 border-default inset-surface">
              <p className="text-[10px] text-surface-200/60">{replySender ?? t("chat.reply")}</p>
              <p className="text-xs text-surface-200/70 line-clamp-2 break-words">
                {replyPreview ?? t("chat.originalUnavailable")}
              </p>
            </div>
          )}
          {msg.deletedAt && <p className="text-sm italic text-surface-200/60">{t("chat.messageDeleted")}</p>}
          {!msg.deletedAt && msg.body && (() => {
            const geo = parseSharedLocation(msg.body);
            if (geo) {
              return (
                <button type="button" onClick={() => onOpenLocation(geo.latitude, geo.longitude)} className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-left hover:bg-accent/20" aria-label={t("chat.openLocationMap")}>
                  <MapPin size={22} className="shrink-0 text-accent-soft" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t("chat.location")}</span>
                    <span className="block text-xs text-surface-200/60">{geo.latitude.toFixed(6)}, {geo.longitude.toFixed(6)}</span>
                    <span className="block text-xs text-accent-soft">{t("chat.openLocationMap")}</span>
                  </span>
                </button>
              );
            }
            const aesMedia = parseAesgcmMediaLink(msg.body);
            if (aesMedia) {
              return (
                <AesgcmMedia
                  url={msg.body.trim()}
                  fileName={aesMedia.fileName}
                  plainHref={aesMedia.href}
                />
              );
            }
            if (!msg.attachments?.length && (trustedFileObjectKey(msg.body.trim(), window.location.origin) || isTrustedXmppUploadUrl(msg.body.trim(), window.location.origin))) {
              return <ReceivedFileLink rawUrl={msg.body.trim()} accountId={activeAccountId} onOpenImage={onOpenImage} />;
            }
            return <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.body}</p>;
          })()}
          {!msg.deletedAt && msg.body && (() => {
            if (parseSharedLocation(msg.body) || trustedFileObjectKey(msg.body.trim(), window.location.origin) || isTrustedXmppUploadUrl(msg.body.trim(), window.location.origin)) return null;
            const url = extractFirstUrl(msg.body);
            return url ? <LinkPreviewCard url={url} /> : null;
          })()}
          {!msg.deletedAt && msg.editedAt && <p className="text-[10px] text-surface-200/40 mt-1 cursor-default" title={`${t("chat.editedAt")} ${formatMsgTimeFull(msg.editedAt)}`}>{t("chat.edited")}</p>}
          {!msg.deletedAt && msg.attachments?.map((att) => (
            <AttachmentView key={att.id} attachment={att} accountId={activeAccountId} onOpenImage={onOpenImage} />
          ))}
          <div className={clsx("mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5", isOwn ? "justify-end" : "justify-start")}>
            {msg.starred && <span className="text-[10px] text-warn">★</span>}
            {msg.encrypted && <Lock size={11} className="text-success" aria-label={t("omemo.enabled")} />}
            {msg.encrypted === false && <span className="inline-flex items-center gap-1 text-[10px] text-warn"><LockOpen size={11} />{t("chat.notEncrypted")}</span>}
            {msg.decryptFailed && <span className="text-[10px] text-danger">{t("chat.decryptFailed")}</span>}
            <span className="text-[10px] text-surface-200/45" title={formatMsgTimeFull(msg.timestamp)}>{formatMsgTime(msg.timestamp)}</span>
            {isOwn && msg.status !== "failed" && <span title={msg.status === "read" ? readLabel : msg.status === "pending" ? t("chat.sending") : sentLabel} aria-label={msg.status === "read" ? readLabel : msg.status === "pending" ? t("chat.sending") : sentLabel} className="text-accent-soft">
              {msg.status === "pending" ? <Clock size={13} /> : msg.status === "read" || msg.status === "delivered" ? <CheckCheck size={13} /> : <Check size={13} />}
            </span>}
            {isOwn && msg.status === "failed" && <button onClick={() => onRetry(msg)} className="text-[10px] text-danger underline">{t("chat.retry")}</button>}
          </div>
        </div>
        {!msg.deletedAt && !!msg.reactions && Object.keys(msg.reactions).length > 0 && (
          <div className="flex gap-1 flex-wrap px-1">
            {Object.entries(msg.reactions).map(([emoji, count]) => (
              <button
                key={emoji}
                onClick={() => onReact(msg, emoji)}
                className="text-[11px] px-1.5 py-0.5 rounded-full border-default bg-surface-800/40"
              >
                {emoji} {count}
              </button>
            ))}
          </div>
        )}
      </div>
      {!msg.deletedAt && <div className="flex items-center self-center">
        <button onClick={() => onReply(msg)} className="p-1.5 rounded-lg hover-surface text-surface-200/30 hover:text-surface-200">
          <CornerUpLeft size={13} />
        </button>
        <div className="relative" ref={menuRef}>
          <button onClick={() => setMenuOpen((v) => !v)} className="p-1.5 rounded-lg hover-surface text-surface-200/30 hover:text-surface-200">
            <MoreVertical size={13} />
          </button>
          {menuOpen && (
            <div className={clsx("absolute top-7 z-20 w-[8.5rem] rounded-lg border-default bg-surface-900 p-1 shadow-xl", isOwn ? "left-0" : "right-0")}>
              <button onClick={() => { onToggleStar(msg); setMenuOpen(false); }} className="w-full text-left text-xs px-2 py-1.5 hover-surface rounded flex items-center gap-2">
                <Star size={12} /> {msg.starred ? "Unstar" : "Star"}
              </button>
              {isOwn && (
                <button onClick={() => { onEdit(msg); setMenuOpen(false); }} className="w-full text-left text-xs px-2 py-1.5 hover-surface rounded flex items-center gap-2">
                  <Pencil size={12} /> Edit
                </button>
              )}
              <button onClick={() => { onForward(msg); setMenuOpen(false); }} className="w-full text-left text-xs px-2 py-1.5 hover-surface rounded flex items-center gap-2">
                <Forward size={12} /> Forward
              </button>
              <div className="grid grid-cols-7 gap-0 border-b border-subtle px-1 py-1">
                {["👍", "❤️", "😂", "😮", "😢", "🙏"].map((em) => (
                  <button
                    key={em}
                    onClick={() => { onReact(msg, em); setMenuOpen(false); }}
                    className="flex h-6 min-w-0 items-center justify-center rounded text-sm hover-surface"
                    title={`React with ${em}`}
                  >
                    {em}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); setShowReactionPicker(true); }}
                  className="flex h-6 min-w-0 items-center justify-center rounded text-sm hover-surface"
                  title={t("chat.moreReactions")}
                  aria-label={t("chat.moreReactions")}
                >
                  …
                </button>
              </div>
              {isOwn && msg.status !== "failed" && (
                <button onClick={() => { onDelete(msg); setMenuOpen(false); }} className="w-full text-left text-xs px-2 py-1.5 hover-surface rounded text-danger flex items-center gap-2">
                  <Trash2 size={12} /> {t("chat.delete")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>}
      {showReactionPicker && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3"
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.chooseReaction")}
          onClick={() => setShowReactionPicker(false)}
        >
          <div className="max-w-full" onClick={(event) => event.stopPropagation()}>
            <EmojiPicker
              theme={document.documentElement.classList.contains("light") ? Theme.LIGHT : Theme.DARK}
              emojiStyle={EmojiStyle.NATIVE}
              lazyLoadEmojis
              width="min(350px, calc(100vw - 24px))"
              height={420}
              onEmojiClick={(emojiData) => {
                onReact(msg, emojiData.emoji);
                setShowReactionPicker(false);
              }}
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function TypingBubble({ name, avatarSrc }: { name: string; avatarSrc?: string }) {
  return (
    <div className="flex gap-2 items-end">
      <Avatar name={name} src={avatarSrc} size="xs" />
      <div className="msg-bubble-in flex items-center gap-1 py-3">
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-surface-200/40 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

function ReplyPreview({ msg, onCancel, title }: { msg: ChatMessage; onCancel: () => void; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-subtle bg-surface-900/30">
      <div className="w-0.5 h-8 bg-accent rounded-full flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-accent-soft font-medium">{title} {msg.senderJid.split("@")[0]}</p>
        <p className="text-xs text-surface-200/50 truncate">{msg.body}</p>
      </div>
      <button onClick={onCancel} className="text-surface-200/30 hover:text-surface-200 p-1">
        <X size={12} />
      </button>
    </div>
  );
}

function ForwardModal({
  message,
  candidates,
  targetId,
  onSelectTarget,
  onConfirm,
  onCancel,
}: {
  message: ChatMessage;
  candidates: { id: string; title?: string; peerJid: string; type: string }[];
  targetId: string;
  onSelectTarget: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");
  const filtered = candidates.filter((c) =>
    (c.title ?? c.peerJid).toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border-default bg-surface-900 shadow-2xl p-4 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-surface-50">{t("chat.forwardMessage")}</h3>
        <p className="text-xs text-surface-200/50 line-clamp-2">{message.body}</p>
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("chat.searchConversations")}
          className="input-field text-sm"
        />
        <div className="max-h-52 overflow-y-auto flex flex-col gap-1 pr-1">
          {filtered.length === 0 && (
            <p className="text-xs text-surface-200/30 text-center py-4">{t("chat.noMatchingConversations")}</p>
          )}
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelectTarget(c.id)}
              className={clsx(
                "w-full text-left text-sm px-3 py-2 rounded-lg transition-colors",
                targetId === c.id
                  ? "bg-accent/20 text-accent-soft"
                  : "hover-surface text-surface-200/70"
              )}
            >
              {c.title ?? c.peerJid}
              <span className="text-xs text-surface-200/30 ml-1.5">
                ({c.type === "group" ? t("chat.groupConversation") : t("chat.privateConversation")})
              </span>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onCancel} className="btn-ghost text-sm">{t("common.cancel")}</button>
          <button
            onClick={onConfirm}
            disabled={!targetId}
            className="btn-primary text-sm"
          >
            {t("chat.forward")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const { t } = useLanguage();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-full object-contain rounded-lg border-default"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      />
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-black/50 border border-default text-white hover:bg-black/70"
        title={t("common.close")}
      >
        <X size={16} className="mx-auto" />
      </button>
    </div>
  );
}

export default function MessageView({ conversationId }: { conversationId: string }) {
  const [searchParams] = useSearchParams();
  const { t } = useLanguage();
  const [input, setInput] = useState("");
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  // Track the resolved theme so the third-party emoji picker can follow it.
  // We watch the .light / .dark class on <html> via MutationObserver.
  const [emojiPickerTheme, setEmojiPickerTheme] = useState<Theme>(() => {
    if (typeof document !== "undefined" && document.documentElement.classList.contains("light")) {
      return Theme.LIGHT;
    }
    return Theme.DARK;
  });
  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setEmojiPickerTheme(root.classList.contains("light") ? Theme.LIGHT : Theme.DARK);
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  const [pluginToolbarActions, setPluginToolbarActions] = useState<ChatToolbarAction[]>([]);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([]);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [viewingLocation, setViewingLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null);
  const [forwardTargetId, setForwardTargetId] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const loadedDraftConversationRef = useRef<string | null>(null);

  useEffect(() => { setPendingDelete(null); }, [conversationId]);

  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const conversation = useChatStore((s) => s.conversations[conversationId]);
  const upsertRoom = useGroupStore((s) => s.upsertRoom);
  const peerContact = useRosterStore((s) =>
    activeAccountId && conversation?.peerJid ? s.getContact(activeAccountId, conversation.peerJid) : undefined
  );
  const upsertContact = useRosterStore((s) => s.upsertContact);
  const allConversations = useChatStore((s) => Object.values(s.conversations));
  const messages = useChatStore((s) => s.messages[conversationId] ?? []);
  const messagesRef = useRef(messages);
  const composerDraft = useChatStore((s) => s.composerDrafts[conversationId] ?? "");
  const addMessage = useChatStore((s) => s.addMessage);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const removeLocalMessage = useChatStore((s) => s.removeLocalMessage);
  const toggleMessageStar = useChatStore((s) => s.toggleMessageStar);
  const toggleMessageReaction = useChatStore((s) => s.toggleMessageReaction);
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const clearComposerDraft = useChatStore((s) => s.clearComposerDraft);
  const messageMap = new Map<string, ChatMessage>(messages.map((m) => [m.id, m]));
  const { peerIsTyping, onInputChange, onBlur } = useTypingIndicator(conversation?.peerJid ?? "");
  const { fetchHistory, loading: mamLoading, hasMore } = useMAM(conversation?.peerJid ?? "", conversationId);
  const forwardCandidates = allConversations
    .filter((c) => c.accountId === activeAccountId && c.id !== conversationId)
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  const syncComposerValue = useCallback((nextValue: string, el?: HTMLTextAreaElement | null) => {
    setInput(nextValue);
    setComposerDraft(conversationId, nextValue);
    onInputChange();
    const target = el ?? textareaRef.current;
    if (target) {
      target.style.height = "auto";
      target.style.height = Math.min(target.scrollHeight, 120) + "px";
    }
  }, [conversationId, onInputChange, setComposerDraft]);
  const peerDomain = (conversation?.peerJid.split("@")[1] ?? "").toLowerCase();
  const isMucPeer =
    conversation?.type === "group"
    || peerDomain.startsWith("conference.")
    || peerDomain.includes(".conference.");
  const needsContactApproval = Boolean(
    conversation?.type === "private"
      && !isMucPeer
      && peerContact?.pendingIncoming
      && !peerContact.isBlocked
  );

  const appendToComposer = useCallback((text: string) => {
    syncComposerValue([input.trim(), text].filter(Boolean).join("\n"));
    textareaRef.current?.focus();
  }, [input, syncComposerValue]);

  const uploadSelectedFiles = useCallback(async (files: File[]) => {
    if (!files.length || !activeAccountId) return;
    if (conversation?.type === "group" || editingMessageId) {
      toast.error(t("chat.attachDirectOnly"));
      return;
    }
    const accepted = files.filter((file) => {
      if (file.size <= 100 * 1024 * 1024) return true;
      toast.error(`${file.name}: ${t("upload.maxPerFile")}`);
      return false;
    });
    setUploadingCount((count) => count + accepted.length);
    try {
      await Promise.all(accepted.map(async (file) => {
        try {
          const result = await attachmentsApi.upload(file, undefined, activeAccountId);
          setPendingFiles((pending) => [...pending, {
            id: result.id,
            name: result.file_name,
            mimeType: result.mime_type,
            sizeBytes: result.size_bytes,
            downloadUrl: result.download_url,
          }]);
        } catch (error: any) {
          const detail = error?.response?.data?.detail ?? error?.message ?? t("upload.error");
          toast.error(typeof detail === "string" ? detail : t("upload.error"));
        }
      }));
    } finally {
      setUploadingCount((count) => count - accepted.length);
    }
  }, [activeAccountId, conversation?.type, editingMessageId, t]);

  const shareLocation = () => {
    setAttachmentMenuOpen(false);
    setLocationDialogOpen(true);
  };

  const openCapture = () => {
    setAttachmentMenuOpen(false);
    setCaptureOpen(true);
  };

  const pasteFromClipboard = async () => {
    setAttachmentMenuOpen(false);
    if (!navigator.clipboard) {
      toast.error(t("chat.clipboardUnavailable"));
      return;
    }
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        const files: File[] = [];
        for (const item of items) {
          for (const mimeType of item.types.filter((type) => type.startsWith("image/"))) {
            const blob = await item.getType(mimeType);
            files.push(new File([blob], `clipboard-${Date.now()}.${mimeType.split("/")[1] || "png"}`, { type: mimeType }));
            break;
          }
        }
        if (files.length) {
          await uploadSelectedFiles(files);
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      if (text) appendToComposer(text);
      else toast.error(t("chat.clipboardEmpty"));
    } catch {
      toast.error(t("chat.clipboardUnavailable"));
    }
  };

  const shareContact = async () => {
    setAttachmentMenuOpen(false);
    const contactPicker = (navigator as Navigator & {
      contacts?: { select: (properties: string[], options: { multiple: boolean }) => Promise<Array<{ name?: string[]; tel?: string[] }>> };
    }).contacts;
    if (!contactPicker) {
      setContactDialogOpen(true);
      return;
    }
    try {
      const [contact] = await contactPicker.select(["name", "tel"], { multiple: false });
      if (contact) appendToComposer([contact.name?.[0], contact.tel?.[0]].filter(Boolean).join("\n"));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setContactDialogOpen(true);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      if (!conversation) return;
      if (messages.length > 0) return;

      const localMessages = await getLocalMessages(conversationId, 200);
      if (!cancelled && localMessages.length > 0) {
        localMessages.forEach((m) => addMessage(m, { countAsUnread: false }));
      }

      if (!cancelled && localMessages.length === 0) {
        await fetchHistory();
      }
    };

    bootstrap().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, conversation, messages.length, addMessage, fetchHistory]);

  useEffect(() => {
    if (!activeAccountId || !conversation || conversation.type !== "group") return;
    const client = getClient(activeAccountId);
    if (!client?.connected) return;
    const roomJid = conversation.peerJid;
    const nickname = client.config.jid.split("@")[0] || "user";

    // Skip auto-join if we're already joined / joining / kicked / destroyed.
    // (Only auto-attempt for "idle" or "error" states.)
    const existing = useGroupStore.getState().getRoom(activeAccountId, roomJid);
    if (existing && (existing.joinState === "joined" || existing.joinState === "joining"
                  || existing.joinState === "kicked" || existing.joinState === "destroyed")) {
      return;
    }

    upsertRoom({
      accountId: activeAccountId,
      jid: roomJid,
      name: conversation.title || roomJid.split("@")[0],
      nickname,
      isPublic: true,
      joinState: "joining",
    });
    client.joinRoom(roomJid, nickname).catch((err) => {
      // The bridge's room.join.failed handler will set joinState=error.
      // eslint-disable-next-line no-console
      console.warn(`[MUC] auto-join from chat view failed: ${err?.message}`);
    });
  }, [activeAccountId, conversation, upsertRoom]);

  useEffect(() => {
    if (loadedDraftConversationRef.current === conversationId) return;
    loadedDraftConversationRef.current = conversationId;
    let cancelled = false;
    const loadDraft = async () => {
      if (composerDraft) {
        setInput(composerDraft);
        return;
      }
      const persisted = await getDraft(conversationId);
      if (cancelled || !persisted) return;
      setComposerDraft(conversationId, persisted);
      setInput(persisted);
    };
    loadDraft().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, setComposerDraft]);

  useEffect(() => {
    if (isComposingRef.current) return;
    setInput((prev) => (prev === composerDraft ? prev : composerDraft));
  }, [composerDraft]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveDraft(conversationId, input).catch(() => {});
    }, 200);
    return () => window.clearTimeout(timer);
  }, [conversationId, input]);

  // Keep messagesRef in sync so plugin actions always read the latest messages
  // without re-triggering the plugin-load effect on every incoming message
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const loadActions = async () => {
      if (!conversation) {
        if (!cancelled) setPluginToolbarActions([]);
        return;
      }
      const actions = await getChatToolbarActions({
        accountId: activeAccountId,
        conversationId,
        peerJid: conversation.peerJid,
        messages: messagesRef.current,
        addSystemMessage: (body: string) => {
          const systemMessage: ChatMessage = {
            id: crypto.randomUUID(),
            conversationId,
            senderJid: "system",
            body,
            bodyType: "text",
            direction: "system",
            status: "delivered",
            timestamp: Date.now(),
          };
          addMessage(systemMessage);
          cacheMessages([systemMessage]).catch(() => {});
        },
      });
      if (!cancelled) setPluginToolbarActions(actions);
    };
    loadActions().catch(() => {
      if (!cancelled) setPluginToolbarActions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAccountId, conversationId, conversation?.peerJid, addMessage]);

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    if (!isNearBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, peerIsTyping]);

  useEffect(() => {
    if (!showEmojiPicker) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (composerRef.current?.contains(target)) return;
      setShowEmojiPicker(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [showEmojiPicker]);

  useEffect(() => {
    const targetId = searchParams.get("mid");
    if (!targetId) return;
    const target = messageNodeRefs.current[targetId];
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("ring-2", "ring-accent", "rounded-xl");
    const timer = window.setTimeout(() => {
      target.classList.remove("ring-2", "ring-accent", "rounded-xl");
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [messages, searchParams]);

  const handleScroll = () => {
    const c = containerRef.current;
    if (!c) return;
    const distFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
    isNearBottomRef.current = distFromBottom < 200;
    setShowScrollBtn(distFromBottom > 300);
    if (c.scrollTop < 80 && hasMore && !mamLoading) fetchHistory();
  };

  const sendMessage = useCallback(async () => {
    let body = input.trim();
    const pastedLocation = parseSharedLocation(body);
    if (pastedLocation && !body.startsWith("geo:")) {
      body = `geo:${pastedLocation.latitude.toFixed(6)},${pastedLocation.longitude.toFixed(6)}`;
    }
    if (!body && !pendingFiles.length) return;
    if (uploadingCount > 0) return;
    if (!activeAccountId) return;
    if (needsContactApproval) {
      toast.error(t("chat.addContactBeforeReply"));
      return;
    }

    // Slash command interception
    if (body.startsWith("/")) {
      const result = await processSlashCommand(body, {
        conversationId,
        accountId: activeAccountId,
        insertText: (text: string) => setInput(text),
        showSystemMessage: (b: string) => {
          const sysMsg: ChatMessage = {
            id: crypto.randomUUID(),
            conversationId,
            senderJid: "system",
            body: b,
            bodyType: "text",
            direction: "system",
            status: "delivered",
            timestamp: Date.now(),
          };
          addMessage(sysMsg);
          cacheMessages([sysMsg]).catch(() => {});
        },
      });
      if (result.handled) {
        if (result.replacement === null) {
          // command consumed - clear input, don't send anything
          setInput("");
          clearComposerDraft(conversationId);
          return;
        }
        if (result.replacement) {
          body = result.replacement;
        }
      }
    }

    const client = getClient(activeAccountId);
    if (!client?.connected) {
      toast.error(t("chat.notConnected"));
      return;
    }
    const peerJid = conversation?.peerJid ?? conversationId;
    const isExternalPeer = peerJid.split("/")[0].split("@")[1]?.toLowerCase() !== client.config.jid.split("@")[1]?.split("/")[0].toLowerCase();
    if (pendingFiles.length) {
      if (isExternalPeer && !getOmemoEnabled()) {
        toast.error(t("media.enableOmemoForFederation"));
        return;
      }
      if (conversation?.type === "group" || editingMessageId) {
        toast.error("File sharing is available for direct chats only");
        return;
      }
    }
    let id = "";
    let sentEncrypted = false;
    try {
      let outboundBody = body;
      if (body && conversation?.type === "group" && getGroupOmemoEnabled(activeAccountId, peerJid)) {
        const envelope = await encryptGroupOmemoMessage(activeAccountId, peerJid, body);
        if (!envelope) throw new Error("Cannot encrypt for every group member");
        id = client.sendOmemoMessage(
          peerJid, envelope, "groupchat",
          editingMessageId
            ? { replaceId: editingMessageId }
            : (replyTo ? { replyToId: replyTo.id, replyToJid: replyTo.senderJid } : undefined),
          body
        );
        sentEncrypted = true;
      } else if (body && conversation?.type === "private" && getOmemoEnabled()) {
        const peerJid = conversation?.peerJid ?? conversationId;
        // Try libsignal-based OMEMO first (XEP-0384, interop with Conversations/Gajim).
        // Fall back to legacy custom-protocol OMEMO if peer hasn't published a bundle.
        let envelope: any = await tryLibsignalEncrypt(activeAccountId, peerJid, body);
        if (!envelope) {
          const encrypted = await encryptOmemoEnvelopeForPeer(activeAccountId, peerJid, body);
          if (!encrypted.usedPeerKey || !encrypted.envelope) {
            const sendPlain = window.confirm(t("omemo.sendPlaintextConfirm"));
            if (!sendPlain) return;
            id = client.sendMessage(
              peerJid,
              outboundBody,
              "chat",
              editingMessageId
                ? { replaceId: editingMessageId }
                : (replyTo ? { replyToId: replyTo.id, replyToJid: replyTo.senderJid } : undefined)
            );
            toast(t("omemo.sentPlaintext"));
          } else {
            envelope = encrypted.envelope;
          }
        }
        if (envelope) {
          id = client.sendOmemoMessage(
            peerJid,
            envelope,
            "chat",
            editingMessageId
              ? { replaceId: editingMessageId }
              : (replyTo ? { replyToId: replyTo.id, replyToJid: replyTo.senderJid } : undefined)
          );
          sentEncrypted = true;
        }
      } else {
        id = body ? client.sendMessage(
          conversation?.peerJid ?? conversationId,
          outboundBody,
          conversation?.type === "group" ? "groupchat" : "chat",
          editingMessageId
            ? { replaceId: editingMessageId }
            : (replyTo ? { replyToId: replyTo.id, replyToJid: replyTo.senderJid } : undefined)
        ) : "";
      }
    } catch (error: any) {
      if (body) {
        const failedMessage: ChatMessage = {
          id: crypto.randomUUID(),
          conversationId,
          senderJid: client.config.jid,
          body,
          bodyType: "text",
          direction: "out",
          status: "failed",
          encrypted: conversation?.type === "group"
            ? getGroupOmemoEnabled(activeAccountId, peerJid)
            : getOmemoEnabled(),
          timestamp: Date.now(),
          replyToId: replyTo?.id,
        };
        addMessage(failedMessage, { countAsUnread: false });
      }
      toast.error(error?.message ?? t("chat.sendFailed"));
      return;
    }
    if (body) {
      const outgoingMessage: ChatMessage = {
        id,
        conversationId,
        body,
        senderJid: client.config.jid,
        bodyType: "text",
        direction: "out",
        status: "sent",
        timestamp: Date.now(),
        replyToId: replyTo?.id,
        encrypted: sentEncrypted,
      };
      if (editingMessageId) {
        updateMessage(conversationId, editingMessageId, { body, editedAt: Date.now() });
      } else {
        addMessage(outgoingMessage);
        cacheMessages([outgoingMessage]).catch(() => {});
      }
    }
    try {
      for (const file of pendingFiles) {
        const original = await privateFileBlob(file.downloadUrl, activeAccountId);
        const mediaUrl = await publishFederatedMedia(original, file.name, activeAccountId);
        let fileEncrypted = false;
        let fileId: string;
        if (getOmemoEnabled()) {
          const envelope = await tryLibsignalEncrypt(activeAccountId, peerJid, mediaUrl);
          if (!envelope) throw new Error("Cannot encrypt media link for this recipient");
          fileId = client.sendOmemoMessage(peerJid, envelope, "chat");
          fileEncrypted = true;
        } else {
          fileId = client.sendMessage(peerJid, mediaUrl, "chat");
        }
        const fileMessage: ChatMessage = {
          id: fileId, conversationId, senderJid: client.config.jid,
          body: mediaUrl, bodyType: "text", direction: "out",
          status: "sent", timestamp: Date.now(), encrypted: fileEncrypted,
        };
        addMessage(fileMessage);
        cacheMessages([fileMessage]).catch(() => {});
      }
    } catch (error: any) {
      toast.error(error?.message ?? t("chat.sendFailed"));
      return;
    }
    setInput("");
    clearComposerDraft(conversationId);
    saveDraft(conversationId, "").catch(() => {});
    setReplyTo(null);
    setEditingMessageId(null);
    setPendingFiles([]);
    setAttachmentMenuOpen(false);
    setShowEmojiPicker(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, pendingFiles, uploadingCount, activeAccountId, needsContactApproval, conversationId, conversation, addMessage, updateMessage, replyTo, editingMessageId, t, clearComposerDraft]);

  const handleAcceptContact = useCallback(() => {
    if (!activeAccountId || !conversation?.peerJid) return;
    const client = getClient(activeAccountId);
    if (!client?.connected) {
      toast.error(t("chat.notConnected"));
      return;
    }
    client.approveSubscription(conversation.peerJid);
    client.addContact(conversation.peerJid, peerContact?.name);
    upsertContact({
      accountId: activeAccountId,
      jid: conversation.peerJid,
      name: peerContact?.name,
      groups: peerContact?.groups ?? [],
      subscription: "both",
      pendingIncoming: false,
      presence: peerContact?.presence ?? "unavailable",
      statusText: peerContact?.statusText,
      avatarUrl: peerContact?.avatarUrl,
      isBlocked: false,
    });
    toast.success(t("roster.accepted"));
  }, [activeAccountId, conversation?.peerJid, peerContact, t, upsertContact]);

  const handleEditMessage = useCallback((message: ChatMessage) => {
    if (message.direction !== "out") return;
    setEditingMessageId(message.id);
    setInput(message.body);
    setComposerDraft(conversationId, message.body);
    textareaRef.current?.focus();
  }, [conversationId, setComposerDraft]);

  const handleForwardMessage = useCallback((message: ChatMessage) => {
    setForwardingMessage(message);
    setForwardTargetId("");
  }, []);

  const handleConfirmForward = useCallback(async () => {
    if (!forwardingMessage || !forwardTargetId || !activeAccountId) return;
    const target = allConversations.find((c) => c.id === forwardTargetId);
    if (!target) return;
    const client = getClient(activeAccountId);
    if (!client?.connected) {
      toast.error(t("chat.notConnected"));
      return;
    }
    try {
      const forwardedBody = `↩ ${forwardingMessage.body}`;
      if (target.type === "group" && getGroupOmemoEnabled(activeAccountId, target.peerJid)) {
        const envelope = await encryptGroupOmemoMessage(activeAccountId, target.peerJid, forwardedBody);
        if (!envelope) throw new Error("Cannot encrypt for every group member");
        client.sendOmemoMessage(target.peerJid, envelope, "groupchat", undefined, forwardedBody);
      } else if (target.type === "private" && getOmemoEnabled()) {
        const envelope = await tryLibsignalEncrypt(activeAccountId, target.peerJid, forwardedBody);
        if (!envelope) throw new Error("Cannot encrypt forwarded message for this recipient");
        client.sendOmemoMessage(target.peerJid, envelope, "chat", undefined, forwardedBody);
      } else {
        client.sendMessage(target.peerJid, forwardedBody, target.type === "group" ? "groupchat" : "chat");
      }
      toast.success("Forwarded");
      setForwardingMessage(null);
      setForwardTargetId("");
    } catch (error: any) {
      toast.error(error?.message ?? t("chat.sendFailed"));
    }
  }, [forwardingMessage, forwardTargetId, activeAccountId, allConversations, t]);

  const handleDeleteMessage = useCallback((message: ChatMessage) => {
    if (message.direction === "out" && !message.deletedAt) setPendingDelete(message);
  }, []);

  const handleDeleteForMe = useCallback(() => {
    if (!pendingDelete || pendingDelete.conversationId !== conversationId || !conversation) return;
    removeLocalMessage(conversationId, pendingDelete.id);
    void deleteLocalMessage(conversationId, pendingDelete.id).catch(() => {});
    removeFromIndex(conversationId, pendingDelete.id, conversation.accountId);
    setPendingDelete(null);
  }, [pendingDelete, conversation, conversationId, removeLocalMessage]);

  const handleDeleteForEveryone = useCallback(() => {
    if (!pendingDelete || pendingDelete.conversationId !== conversationId || !activeAccountId || !conversation) return;
    const client = getClient(activeAccountId);
    if (!client?.connected) {
      toast.error(t("chat.notConnected"));
      return;
    }
    const targetId = conversation.type === "group" ? pendingDelete.stanzaId : pendingDelete.id;
    if (!targetId) {
      toast.error(t("chat.deleteServerIdMissing"));
      return;
    }
    try {
      client.retractMessage(conversation.peerJid, targetId, conversation.type === "group" ? "groupchat" : "chat");
      applyMessageRetraction(conversationId, pendingDelete.id);
      setPendingDelete(null);
    } catch (error: any) {
      toast.error(error?.message ?? t("chat.sendFailed"));
    }
  }, [activeAccountId, conversation, conversationId, pendingDelete, t]);

  const handleToggleStar = useCallback((message: ChatMessage) => {
    toggleMessageStar(conversationId, message.id);
  }, [conversationId, toggleMessageStar]);

  const handleReact = useCallback((message: ChatMessage, emoji: string) => {
    // Update local store immediately for responsiveness
    toggleMessageReaction(conversationId, message.id, emoji);
    // Sync to XMPP peer via XEP-0444
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    if (!client?.connected || !conversation?.peerJid) return;
    // Build the full current reaction set for this user to send
    const updatedMsg = useChatStore.getState().messages[conversationId]
      ?.find((m) => m.id === message.id);
    const myEmojis = Object.entries(updatedMsg?.reactions ?? {})
      .filter(([, count]) => count > 0)
      .map(([em]) => em);
    client.sendReaction(
      conversation.peerJid,
      message.id,
      myEmojis,
      conversation.type === "group" ? "groupchat" : "chat"
    );
  }, [conversationId, toggleMessageReaction, activeAccountId, conversation]);

  const retryFailedMessage = useCallback((message: ChatMessage) => {
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    if (!client?.connected) {
      toast.error(t("chat.notConnected"));
      return;
    }
    const retry = async () => {
      try {
        const isPrivateOmemo = Boolean(
          message.encrypted
            && conversation?.type === "private"
            && getOmemoEnabled()
            && message.body
        );
        let newId = "";
        if (message.encrypted && conversation?.type === "group" && message.body) {
          const peerJid = conversation.peerJid;
          const envelope = await encryptGroupOmemoMessage(activeAccountId, peerJid, message.body);
          if (!envelope) throw new Error("Cannot encrypt for every group member");
          newId = client.sendOmemoMessage(peerJid, envelope, "groupchat", undefined, message.body);
        } else if (isPrivateOmemo) {
          const peerJid = conversation?.peerJid ?? conversationId;
          // libsignal-first OMEMO encryption with legacy fallback
          let envelope: any = await tryLibsignalEncrypt(activeAccountId, peerJid, message.body);
          if (!envelope) {
            const encrypted = await encryptOmemoEnvelopeForPeer(activeAccountId, peerJid, message.body);
            if (!encrypted.usedPeerKey || !encrypted.envelope) {
              const sendPlain = window.confirm(t("omemo.sendPlaintextConfirm"));
              if (!sendPlain) return;
              newId = client.sendMessage(peerJid, message.body, "chat");
              toast(t("omemo.sentPlaintext"));
            } else {
              envelope = encrypted.envelope;
            }
          }
          if (envelope) {
            newId = client.sendOmemoMessage(
              peerJid,
              envelope,
              "chat"
            );
          }
        } else {
          newId = client.sendMessage(
            conversation?.peerJid ?? conversationId,
            message.body,
            conversation?.type === "group" ? "groupchat" : "chat"
          );
        }
        updateMessage(conversationId, message.id, { id: newId, status: "sent", timestamp: Date.now() });
      } catch (error: any) {
        toast.error(error?.message ?? t("chat.sendFailed"));
      }
    };
    void retry();
  }, [activeAccountId, conversation, conversationId, t, updateMessage]);

  const handleComposerPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault();
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    if (!client?.connected) {
      toast.error(t("chat.notConnected"));
      return;
    }
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const result = await attachmentsApi.upload(file, undefined, activeAccountId ?? undefined);
        setPendingFiles((prev) => [
          ...prev,
          {
            id: result.id,
            name: result.file_name,
            mimeType: result.mime_type,
            sizeBytes: result.size_bytes,
            downloadUrl: result.download_url,
          },
        ]);
      } catch {
        toast.error(t("upload.error"));
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composing phase (e.g. Chinese pinyin): do not intercept Enter/Backspace flow.
    const nativeComposing = (e.nativeEvent as KeyboardEvent).isComposing;
    if (nativeComposing || isComposingRef.current || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  if (!conversation) return <div className="flex items-center justify-center h-full text-surface-200/30 text-sm">{t("chat.notFound")}</div>;

  const useVirtualMessages = messages.length > 300;
  const highlightedMessageId = searchParams.get("mid");
  const renderMessageContent = (msg: ChatMessage) => {
    const isOwn = msg.direction === "out";
    return msg.direction === "system" ? (
      <div className="msg-bubble-system">{msg.body}</div>
    ) : (
      <MessageBubble
        msg={msg}
        replyPreview={msg.replyToId ? messageMap.get(msg.replyToId)?.body : undefined}
        replySender={msg.replyToId ? messageMap.get(msg.replyToId)?.senderJid.split("@")[0] : undefined}
        isOwn={isOwn}
        onReply={setReplyTo}
        onOpenImage={(src, alt) => setLightbox({ src, alt })}
        onOpenLocation={(latitude, longitude) => setViewingLocation({ latitude, longitude })}
        onRetry={retryFailedMessage}
        onEdit={handleEditMessage}
        onForward={handleForwardMessage}
        onDelete={handleDeleteMessage}
        onToggleStar={handleToggleStar}
        onReact={handleReact}
        sentLabel={t("chat.sentSent")}
        readLabel={t("chat.sentRead")}
        activeAccountId={activeAccountId}
        avatarSrc={conversation.type === "private" ? peerContact?.avatarUrl : undefined}
      />
    );
  };

  return (
    <div className="flex flex-col h-full relative">
      <div
        ref={containerRef}
        onScroll={useVirtualMessages ? undefined : handleScroll}
        className={clsx(
          "flex-1 min-h-0",
          useVirtualMessages ? "flex" : "overflow-y-auto px-2 py-2 sm:px-4 sm:py-3 flex flex-col gap-1.5"
        )}
      >
        {hasMore && (
          <div className={clsx("flex justify-center py-2", useVirtualMessages && "hidden")}>
            <button
              onClick={fetchHistory}
              disabled={mamLoading}
              className="text-xs text-surface-200/40 hover:text-surface-200 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-900 hover:bg-surface-800 transition-colors"
            >
              {mamLoading && <Loader size={11} className="animate-spin" />}
              {mamLoading ? t("chat.loading") : t("chat.loadOlder")}
            </button>
          </div>
        )}
        {messages.length === 0 && !mamLoading && (
          <div className="flex flex-col items-center justify-center flex-1 gap-2 text-surface-200/25">
            <p className="text-sm">{t("chat.noMessages")}</p>
          </div>
        )}
        {useVirtualMessages ? (
          <VirtualMessageList
            messages={messages}
            conversation={conversation}
            highlightId={highlightedMessageId}
            hasMore={hasMore}
            loadingOlder={mamLoading}
            onLoadOlder={fetchHistory}
            renderMessage={renderMessageContent}
            todayLabel={t("chat.today")}
            yesterdayLabel={t("chat.yesterday")}
            unreadLabel={t("chat.unread")}
            loadingLabel={t("chat.loading")}
            loadOlderLabel={t("chat.loadOlder")}
          />
        ) : messages.map((msg, i) => {
          const isOwn = msg.direction === "out";
          const prev = messages[i - 1];
          const showDate = !prev || !isSameDay(msg.timestamp, prev.timestamp);
          const unreadStartIdx = conversation.unreadCount > 0 ? Math.max(messages.length - conversation.unreadCount, 0) : -1;
          const showUnreadDivider = unreadStartIdx === i && conversation.unreadCount > 0;
          return (
            <div
              key={msg.id}
              className="animate-fade-in"
              ref={(node) => { messageNodeRefs.current[msg.id] = node; }}
              data-mid={msg.id}
            >
              {showDate && <DateDivider date={msg.timestamp} todayLabel={t("chat.today")} yesterdayLabel={t("chat.yesterday")} />}
              {showUnreadDivider && (
                <div className="flex items-center gap-3 py-2">
                  <div className="flex-1 h-px bg-accent/40" />
                  <span className="text-[10px] text-accent-soft px-2 py-0.5 rounded-full bg-accent/10">{t("chat.unread")}</span>
                  <div className="flex-1 h-px bg-accent/40" />
                </div>
              )}
              {renderMessageContent(msg)}
            </div>
          );
        })}
        {peerIsTyping && <TypingBubble name={conversation.peerJid.split("@")[0]} avatarSrc={conversation.type === "private" ? peerContact?.avatarUrl : undefined} />}
        <div ref={messagesEndRef} />
      </div>

      {showScrollBtn && (
        <button
          onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })}
          className="absolute bottom-24 right-4 w-8 h-8 rounded-full bg-surface-800 border-default flex items-center justify-center text-surface-200/70 hover:text-surface-50 shadow-lg z-10"
        >
          <ChevronDown size={14} />
        </button>
      )}

      {pendingFiles.length > 0 && (
        <div className="px-4 py-2 border-t border-subtle flex gap-2 flex-wrap">
          {pendingFiles.map((f) => (
            <div key={f.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-800 text-xs text-surface-200/70 border-default">
              <span className="truncate max-w-[100px]">{f.name}</span>
              <button onClick={() => setPendingFiles((p) => p.filter((x) => x.id !== f.id))} className="text-surface-200/30 hover:text-danger">
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {replyTo && <ReplyPreview msg={replyTo} onCancel={() => setReplyTo(null)} title={t("chat.replyingTo")} />}
      {editingMessageId && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-subtle bg-surface-900/30">
          <div className="w-0.5 h-8 bg-accent rounded-full flex-shrink-0" />
          <div className="flex-1 min-w-0 text-xs text-surface-200/70">{t("chat.editingMessage")}</div>
          <button
            onClick={() => {
              setEditingMessageId(null);
              setInput("");
              clearComposerDraft(conversationId);
            }}
            className="text-surface-200/30 hover:text-surface-200 p-1"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div
        ref={composerRef}
        className="relative flex-shrink-0 border-t border-subtle bg-surface-950/60 px-2 py-2 sm:px-3"
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setAttachmentMenuOpen(false);
          void uploadSelectedFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {pluginToolbarActions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {pluginToolbarActions.map((action) => (
              <button
                key={action.id}
                onClick={() =>
                  action.onClick({
                    accountId: activeAccountId,
                    conversationId,
                    peerJid: conversation.peerJid,
                    messages,
                    addSystemMessage: (body: string) => {
                      const systemMessage: ChatMessage = {
                        id: crypto.randomUUID(),
                        conversationId,
                        senderJid: "system",
                        body,
                        bodyType: "text",
                        direction: "system",
                        status: "delivered",
                        timestamp: Date.now(),
                      };
                      addMessage(systemMessage);
                      cacheMessages([systemMessage]).catch(() => {});
                    },
                  })
                }
                className="px-2.5 py-1 rounded-lg text-xs border-default bg-surface-800/40 text-surface-200/80 hover:text-surface-50 hover-surface"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-w-0 items-end gap-1.5">
          <button
            type="button"
            onClick={() => { setAttachmentMenuOpen((open) => !open); setShowEmojiPicker(false); }}
            disabled={needsContactApproval}
            aria-expanded={attachmentMenuOpen}
            aria-label={t("chat.attachFile")}
            className={clsx("btn-ghost flex-shrink-0 rounded-full bg-surface-800 p-2", attachmentMenuOpen && "text-accent")}
            title={t("chat.attachFile")}
          >
            <Plus size={16} />
          </button>
          <button
            onClick={() => { setShowEmojiPicker((open) => !open); setAttachmentMenuOpen(false); }}
            className={clsx("btn-ghost flex-shrink-0 p-2", showEmojiPicker && "text-accent")}
            title="Emoji"
          >
            <Smile size={16} />
          </button>
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              maxLength={10000}
              onChange={(e) => syncComposerValue(e.target.value, e.target)}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
                window.requestAnimationFrame(() => {
                  syncComposerValue(textareaRef.current?.value ?? "");
                });
              }}
              onKeyDown={handleKeyDown}
              onPaste={handleComposerPaste}
              onBlur={() => {
                isComposingRef.current = false;
                syncComposerValue(textareaRef.current?.value ?? "");
                onBlur();
              }}
              placeholder={needsContactApproval ? t("chat.addContactBeforeReply") : t("chat.messagePlaceholder")}
              disabled={needsContactApproval}
              rows={1}
              className="chat-composer-input block w-full bg-surface-900 border-default rounded-xl pl-3 pr-12 py-2.5 text-sm text-surface-50 placeholder:text-surface-200/25 focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none min-h-[40px] max-h-[120px] disabled:opacity-60 disabled:cursor-not-allowed"
            />
          {needsContactApproval ? (
            <button
              type="button"
              disabled
              className="btn-ghost absolute bottom-1 right-1 p-2 opacity-60 cursor-not-allowed"
              title={t("chat.addContactBeforeReply")}
            >
              <Mic size={16} />
            </button>
          ) : (
            <VoiceRecorder embedded
              onSend={async (file) => {
                if (!activeAccountId) return;
                const client = getClient(activeAccountId);
                if (!client?.connected) throw new Error(t("chat.notConnected"));
                try {
                  const peerJid = conversation?.peerJid ?? conversationId;
                  const isGroup = conversation?.type === "group";
                  const isExternal = peerJid.split("/")[0].split("@")[1]?.toLowerCase() !== client.config.jid.split("@")[1]?.split("/")[0].toLowerCase();
                  if (!isGroup && isExternal && !getOmemoEnabled()) throw new Error(t("media.enableOmemoForFederation"));
                  // The private /files/ URL requires our API session and cannot be
                  // fetched by Conversations. Share ciphertext through a signed,
                  // unauthenticated XEP-0454 URL for both private and MUC chats.
                  const mediaUrl = await publishFederatedMedia(file, file.name, activeAccountId);
                  let sentEncrypted = false;
                  let sentId: string;
                  if (isGroup && getGroupOmemoEnabled(activeAccountId, peerJid)) {
                    const envelope = await encryptGroupOmemoMessage(activeAccountId, peerJid, mediaUrl);
                    if (!envelope) throw new Error("Cannot encrypt media link for every group member");
                    sentId = client.sendOmemoMessage(peerJid, envelope, "groupchat", undefined, mediaUrl);
                    sentEncrypted = true;
                  } else if (!isGroup && getOmemoEnabled()) {
                    const envelope = await tryLibsignalEncrypt(activeAccountId, peerJid, mediaUrl);
                    if (!envelope) throw new Error("Cannot encrypt media link for this recipient");
                    sentId = client.sendOmemoMessage(peerJid, envelope, "chat");
                    sentEncrypted = true;
                  } else {
                    sentId = client.sendMessage(peerJid, mediaUrl, isGroup ? "groupchat" : "chat");
                  }

                  // Mirror in local store so the user sees their own voice msg
                  const localMsg: ChatMessage = {
                    id: sentId,
                    conversationId,
                    senderJid: client.config.jid,
                    body: mediaUrl,
                    bodyType: "text",
                    direction: "out",
                    status: "sent",
                    encrypted: sentEncrypted,
                    timestamp: Date.now(),
                  };
                  addMessage(localMsg);
                  cacheMessages([localMsg]).catch(() => {});
                  toast.success(t("voice.sent"));
                } catch (e: any) {
                  // Surface real backend error message (e.g. 415 unsupported MIME)
                  const detail = e?.response?.data?.detail ?? e?.message ?? t("voice.sendFailed");
                  toast.error(typeof detail === "string" ? detail : t("voice.sendFailed"));
                }
              }}
            />
          )}
          </div>
          <button onClick={() => void sendMessage()} disabled={needsContactApproval || uploadingCount > 0 || (!input.trim() && !pendingFiles.length)} className="btn-primary flex-shrink-0 rounded-xl p-2.5" title={t("chat.send")}>
            <Send size={16} />
          </button>
        </div>
        <input ref={galleryInputRef} type="file" accept="image/*" multiple className="hidden" aria-hidden="true" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; setAttachmentMenuOpen(false); void uploadSelectedFiles(files); }} />
        <input ref={fileInputRef} type="file" multiple className="hidden" aria-hidden="true" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; setAttachmentMenuOpen(false); void uploadSelectedFiles(files); }} />
        {uploadingCount > 0 && <p className="mt-2 text-xs text-surface-200/70" role="status">{t("chat.uploadingAttachments")}</p>}
        {attachmentMenuOpen && (
          <div
            className="popover-surface absolute bottom-[calc(100%+0.5rem)] left-2 z-30 grid max-h-[min(65dvh,28rem)] w-[min(20rem,calc(100%-1rem))] grid-cols-3 gap-x-2 gap-y-3 overflow-y-auto rounded-2xl p-3"
            aria-label={t("chat.attachFile")}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              setAttachmentMenuOpen(false);
              void uploadSelectedFiles(Array.from(event.dataTransfer.files));
            }}
          >
            {([
              { key: "chat.gallery", icon: ImageIcon, action: () => galleryInputRef.current?.click() },
              { key: "chat.files", icon: FileText, action: () => fileInputRef.current?.click() },
              { key: "chat.location", icon: MapPin, action: shareLocation },
              { key: "chat.contact", icon: UserRound, action: () => void shareContact() },
              { key: "chat.camera", icon: Camera, action: openCapture },
              { key: "chat.paste", icon: ClipboardPaste, action: () => void pasteFromClipboard() },
            ] as const).map(({ key, icon: Icon, action }) => (
              <button key={key} type="button" onClick={action} className="flex min-w-0 flex-col items-center gap-1.5 text-surface-100 hover:text-surface-50" aria-label={t(key)}>
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-800 hover:bg-surface-700 transition-colors"><Icon size={24} strokeWidth={2.2} /></span>
                <span className="truncate text-xs">{t(key)}</span>
              </button>
            ))}
          </div>
        )}
        {needsContactApproval && (
          <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-accent/20 bg-accent/10 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-surface-50">{t("chat.pendingContactTitle")}</p>
              <p className="text-xs text-surface-200/60 truncate">
                {t("chat.pendingContactBody").replace("{jid}", conversation.peerJid)}
              </p>
            </div>
            <button
              type="button"
              onClick={handleAcceptContact}
              className="btn-primary flex items-center gap-1.5 px-3 py-2 text-xs flex-shrink-0"
            >
              <UserPlus size={14} />
              {t("roster.accept")}
            </button>
          </div>
        )}
        {showEmojiPicker && (
          <div className="absolute bottom-16 left-2 right-2 z-20 mx-auto max-w-[350px] overflow-hidden rounded-xl shadow-2xl">
            <EmojiPicker
              theme={emojiPickerTheme}
              emojiStyle={EmojiStyle.NATIVE}
              lazyLoadEmojis
              width="100%"
              height="min(420px, calc(100dvh - 8rem))"
              onEmojiClick={(emojiData) => {
                const next = `${input}${emojiData.emoji}`;
                setInput(next);
                setComposerDraft(conversationId, next);
                textareaRef.current?.focus();
              }}
            />
          </div>
        )}
        <p className="hidden text-[10px] text-surface-200/20 mt-1 pl-1 md:block">{t("chat.hint")}</p>
      </div>
      {contactDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={t("chat.contact")} onClick={() => setContactDialogOpen(false)}>
          <form
            className="popover-surface w-full max-w-sm rounded-2xl p-5 space-y-4"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              const details = [contactName.trim(), contactPhone.trim()].filter(Boolean).join("\n");
              if (!details) return;
              appendToComposer(details);
              setContactName("");
              setContactPhone("");
              setContactDialogOpen(false);
            }}
          >
            <h2 className="text-base font-semibold">{t("chat.contact")}</h2>
            <input className="input-field w-full" value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder={t("chat.contactName")} maxLength={100} autoFocus />
            <input className="input-field w-full" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder={t("chat.contactPhone")} maxLength={64} inputMode="tel" />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setContactDialogOpen(false)}>{t("common.cancel")}</button>
              <button type="submit" className="btn-primary" disabled={!contactName.trim() && !contactPhone.trim()}>{t("chat.addToMessage")}</button>
            </div>
          </form>
        </div>
      )}
      {locationDialogOpen && (
        <LocationPicker
          onSelect={(latitude, longitude) => {
            appendToComposer(`geo:${latitude.toFixed(6)},${longitude.toFixed(6)}`);
            setLocationDialogOpen(false);
          }}
          onClose={() => setLocationDialogOpen(false)}
        />
      )}
      {viewingLocation && (
        <LocationViewer latitude={viewingLocation.latitude} longitude={viewingLocation.longitude} onClose={() => setViewingLocation(null)} />
      )}
      {captureOpen && (
        <MediaCapture
          onCaptured={(file) => { void uploadSelectedFiles([file]); }}
          onFallback={() => fileInputRef.current?.click()}
          onClose={() => setCaptureOpen(false)}
        />
      )}
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
      {forwardingMessage && (
        <ForwardModal
          message={forwardingMessage}
          candidates={forwardCandidates}
          targetId={forwardTargetId}
          onSelectTarget={setForwardTargetId}
          onConfirm={handleConfirmForward}
          onCancel={() => { setForwardingMessage(null); setForwardTargetId(""); }}
        />
      )}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={t("chat.delete")}>
          <div className="popover-surface w-full max-w-sm rounded-2xl p-5 space-y-4">
            <h2 className="text-base font-semibold">{t("chat.deleteForEveryoneQuestion")}</h2>
            <p className="text-sm text-surface-200/70">{t("chat.deleteForEveryoneConfirm")}</p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setPendingDelete(null)}>{t("common.cancel")}</button>
              <button type="button" className="btn-ghost" onClick={handleDeleteForMe}>{t("common.no")}</button>
              <button type="button" className="btn-primary" onClick={handleDeleteForEveryone}>{t("common.yes")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
