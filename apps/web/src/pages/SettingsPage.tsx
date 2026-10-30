import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { getAccountPassword, normalizeAccountJid, setAccountPassword, useAccountStore, XmppAccount, PresenceType } from "@/stores/accountStore";
import { createClient, destroyClient } from "@/services/xmppAdapter";
import { getClient } from "@/services/xmppAdapter";
import { initXmppBridge } from "@/services/xmppBridge";
import { Trash2, Plus, Wifi, WifiOff, Copy, Check, QrCode, MoreHorizontal } from "lucide-react";
import toast from "react-hot-toast";
import { clsx } from "clsx";
import { applyTheme, getStoredTheme, ThemeMode } from "@/utils/theme";
import { getStoredLanguage, Language, setLanguage, useLanguage } from "@/utils/i18n";
import { applyHistoryRetention, clearAllHistoryNow, getStoredHistoryRetentionDays, setStoredHistoryRetentionDays } from "@/services/historyRetention";
import { getIdentityFingerprint, initializeOmemoKeys } from "@/services/omemo";
import { getOmemoEnabled, onOmemoEnabledChange } from "@/services/omemoSettings";
import { useNotificationStore } from "@/stores/notificationStore";
import { accountsApi, authApi, setUserToken, setUserRefreshToken } from "@/services/api";
import Avatar from "@/components/Avatar";
import { apiSocket } from "@/services/apiSocket";
import { isPushSubscribed, isPushSupported, subscribeToPush, unsubscribeFromPush } from "@/services/push";
import { disableNtfy, enableNtfy, getNtfyStatus, testNtfy, type NtfyStatus } from "@/services/ntfy";
import { collectBrowserCapabilities } from "@/services/browserCompatibility";
import { markIntentionalDisconnect } from "@/services/connectionSupervisor";
import { logoutAccount } from "@/services/logoutAccount";
import { isLocalXmppAccount, requireLocalXmppAccount } from "@/services/localXmppAccount";
import { prepareAvatarImage } from "@/services/avatarImage";

/**
 * Same-origin wsUrl helper - matches LoginPage.tsx logic.
 * Avoids hardcoding ws://localhost:5280 which would break reconnects on
 * production deployments where users access via wss://their-domain/.
 */
function deriveSameOriginWsUrl(configured?: string): string {
  if (typeof window === "undefined") return configured || "ws://localhost:5280/xmpp-websocket";
  const sameOrigin = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/xmpp-websocket`;
  if (!configured) return sameOrigin;
  try {
    const u = new URL(configured);
    return u.host === window.location.host ? configured : sameOrigin;
  } catch {
    return sameOrigin;
  }
}


const MENTION_NOTIFY_KEY = "liaot-notify-mention";
const DENSITY_KEY = "liaot-message-density";
const HISTORY_RETENTION_OPTIONS = [0, 1, 3, 7, 30];

function PlatformTitle({ title, platform, color }: { title: string; platform: string; color: string }) {
  const start = title.indexOf(platform);
  if (start < 0) return <>{title}</>;
  return <>{title.slice(0, start)}<span className={color}>{platform}</span>{title.slice(start + platform.length)}</>;
}
type MessageDensity = "comfortable" | "compact";

function ShareQr({
  title,
  description,
  payload,
  copyText,
}: {
  title: string;
  description: string;
  payload: string;
  copyText: string;
}) {
  const { t } = useLanguage();
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [qrReady, setQrReady] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    setQrReady(false);
    QRCode.toCanvas(canvas, payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 112,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then(() => {
        if (!cancelled) setQrReady(true);
      })
      .catch(() => {
        if (!cancelled) setQrReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error(t("settings.copyFailed"));
    }
  };

  return (
    <div className="min-w-0 rounded-lg border-default bg-surface-800/40 p-2 flex items-start gap-2 overflow-hidden">
      <div className="w-28 h-28 shrink-0 rounded-md bg-white flex items-center justify-center">
        <canvas
          ref={qrCanvasRef}
          aria-label={title}
          className={clsx("block max-w-full max-h-full", !qrReady && "hidden")}
        />
        {!qrReady && (
          <QrCode size={28} className="text-surface-900" />
        )}
      </div>
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="text-[10px] text-surface-200/45 leading-snug">{description}</div>
        <div className="font-mono text-[10px] leading-snug text-surface-200/60 break-all">
          {copyText}
          <button type="button" onClick={copy}
            aria-label={copied ? t("settings.copied") : t("common.copy")}
            title={copied ? t("settings.copied") : t("common.copy")}
            className="inline-flex align-middle ml-1 rounded p-1 text-surface-200/70 hover:text-surface-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function AccountCard({ account }: { account: XmppAccount }) {
  const { lang, t } = useLanguage();
  const navigate = useNavigate();
  const updatePresence = useAccountStore((s) => s.updatePresence);
  const updateStatusText = useAccountStore((s) => s.updateStatusText);
  const updateAvatar = useAccountStore((s) => s.updateAvatar);
  const setConnected = useAccountStore((s) => s.setConnected);
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [selectedShare, setSelectedShare] = useState<"contact" | "invite" | null>(null);
  const shareMenuRef = useRef<HTMLDivElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [statusText, setStatusText] = useState(account.statusText ?? "");
  const bareJid = account.jid.split("/")[0].trim().toLowerCase();
  const accountDomain = bareJid.split("@")[1] ?? account.domain;
  const inviteUrl = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const url = new URL("/login", origin || "https://lyaotalk.local");
    url.searchParams.set("invite_domain", accountDomain);
    return url.toString();
  }, [accountDomain]);
  const contactUrl = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const url = new URL("/", origin || "https://lyaotalk.local");
    url.searchParams.set("add_contact", bareJid);
    return url.toString();
  }, [bareJid]);
  const label = (zh: string, en: string) => (lang === "zh-CN" ? zh : en);
  const PRESENCES: { value: PresenceType; label: string; color: string }[] = [
    { value: "available", label: t("presence.available"), color: "bg-success" },
    { value: "away", label: t("presence.away"), color: "bg-warn" },
    { value: "dnd", label: t("presence.dnd"), color: "bg-danger" },
    { value: "unavailable", label: t("presence.offline"), color: "bg-surface-200/40" },
  ];

  useEffect(() => {
    if (!account.connected) return;
    let cancelled = false;
    const client = getClient(account.id);
    void client?.fetchPepAvatar(bareJid).then((avatarUrl) => {
      if (!cancelled && avatarUrl) updateAvatar(account.id, avatarUrl);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [account.id, account.connected, bareJid, updateAvatar]);

  useEffect(() => {
    if (!shareMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!shareMenuRef.current?.contains(event.target as Node)) setShareMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [shareMenuOpen]);

  const connect = async () => {
    setConnecting(true);
    try {
      requireLocalXmppAccount(account.jid);
      const runtimePassword = getAccountPassword(account.id);
      if (!runtimePassword) {
        toast.error("Password not available in this session. Please sign in again.");
        navigate(`/login?jid=${encodeURIComponent(account.jid)}`);
        return;
      }
      const client = createClient({
        jid: account.jid,
        password: runtimePassword,
        wsUrl: deriveSameOriginWsUrl(import.meta.env.VITE_XMPP_WS_URL as string | undefined),
        accountId: account.id,
      });
      initXmppBridge(client);
      client.on("connection.changed", (d: any) => setConnected(account.id, d.status === "connected"));
      await client.connect();
      accountsApi.create({ jid: account.jid, domain: account.jid.split("@")[1] ?? "localhost" }).catch(() => {});
      const tokenRes = await authApi.getUserToken(account.jid, runtimePassword).catch(() => null);
      if (tokenRes?.access_token) {
        setUserToken(account.id, tokenRes.access_token);
        if ((tokenRes as any).refresh_token) {
          setUserRefreshToken(account.id, (tokenRes as any).refresh_token);
        }
      }
      toast.success(`${t("toast.connected")}: ${account.jid}`);
    } catch (e: any) {
      toast.error(e.message ?? t("toast.connectionFailed"));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    // Tell the connection supervisor not to auto-reconnect this account.
    markIntentionalDisconnect(account.id);
    destroyClient(account.id);
    setConnected(account.id, false);
    toast(t("toast.disconnected"));
  };

  const handleRemove = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      const { remoteRevoked } = await logoutAccount(account.id);
      toast[remoteRevoked ? "success" : "error"](remoteRevoked ? t("common.removed") : t("account.removeOffline"));
      navigate(useAccountStore.getState().accounts.length ? "/" : "/login");
    } catch {
      toast.error(t("nav.logoutHistoryFailed"));
    } finally {
      setRemoving(false);
    }
  };

  const changeAvatar = async (file?: File) => {
    if (!file) return;
    const client = getClient(account.id);
    if (!client?.connected) { toast.error(t("toast.connectionFailed")); return; }
    setAvatarSaving(true);
    try {
      const { bytes, dataUrl, width, height } = await prepareAvatarImage(file);
      await client.publishPepAvatar(bytes, "image/jpeg", width, height);
      updateAvatar(account.id, dataUrl);
      toast.success(label("头像已更新", "Avatar updated"));
    } catch (error: any) {
      toast.error(error?.message ?? label("头像更新失败", "Avatar update failed"));
    } finally {
      setAvatarSaving(false);
    }
  };

  if (!isLocalXmppAccount(account.jid)) {
    return (
      <div className="glass rounded-xl p-4 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-surface-50 truncate">{account.jid}</p>
          <p className="text-xs text-surface-200/60">{label("外部账号已不支持网页登录", "External accounts can no longer sign in to LyaoTalk Web")}</p>
        </div>
        <button onClick={handleRemove} disabled={removing} className="btn-ghost text-xs text-danger flex items-center gap-1">
          <Trash2 size={12} /> {t("account.remove")}
        </button>
      </div>
    );
  }

  return (
    <div className={clsx("glass relative rounded-xl p-4 flex flex-col gap-3", shareMenuOpen && "z-20")}>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => avatarInputRef.current?.click()}
          disabled={!account.connected || avatarSaving}
          aria-label={label("更换头像", "Change avatar")}
          title={label("更换头像", "Change avatar")}
          className="shrink-0 rounded-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <Avatar name={account.displayName ?? account.jid} src={account.avatarUrl} size="md" presence={account.presence} />
        </button>
        <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
          disabled={!account.connected || avatarSaving}
          onChange={(event) => { void changeAvatar(event.target.files?.[0]); event.target.value = ""; }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-surface-50 truncate">
            {account.displayName ?? account.jid.split("@")[0]}
          </p>
          <p className="text-xs text-surface-200/50 truncate">{account.jid}</p>
        </div>
        <div className="flex items-center gap-2">
          {account.connected
            ? <span className="text-[10px] text-success font-medium flex items-center gap-1"><Wifi size={10}/> {t("account.online")}</span>
            : <span className="text-[10px] text-surface-200/40 flex items-center gap-1"><WifiOff size={10}/> {t("account.offline")}</span>
          }
          <div ref={shareMenuRef} className="relative">
            <button type="button" onClick={() => { setShareMenuOpen((open) => !open); setSelectedShare(null); }}
              aria-label={label("分享选项", "Share options")}
              aria-expanded={shareMenuOpen}
              title={label("分享选项", "Share options")}
              className="btn-ghost p-1.5 rounded-lg text-surface-200/70 hover:text-surface-50">
              <MoreHorizontal size={18} />
            </button>
            {shareMenuOpen && (
              <div className="absolute right-0 top-full z-30 mt-2 w-[min(21rem,calc(100vw-3rem))] rounded-xl border border-default bg-surface-900 p-2 shadow-2xl">
                <div className="flex gap-1">
                  <button type="button" onClick={() => setSelectedShare("contact")}
                    className={clsx("min-w-0 flex-1 rounded-lg px-2 py-1.5 text-center text-[11px] leading-tight text-surface-50 hover:bg-surface-800", selectedShare === "contact" && "bg-surface-800")}>
                    {label("添加我为联系人", "Add me as a contact")}
                  </button>
                  <button type="button" onClick={() => setSelectedShare("invite")}
                    className={clsx("min-w-0 flex-1 rounded-lg px-2 py-1.5 text-center text-[11px] leading-tight text-surface-50 hover:bg-surface-800", selectedShare === "invite" && "bg-surface-800")}>
                    {label("邀请加入此服务器", "Invite to this server")}
                  </button>
                </div>
                {selectedShare === "contact" && <div className="mt-2"><ShareQr
                  title={label("添加我为联系人", "Add me as a contact")}
                  description={label("联系人扫描后会打开 Lyao Talk 并添加你的 XMPP 地址。", "Scan to open Lyao Talk and add this XMPP address.")}
                  payload={contactUrl} copyText={bareJid} /></div>}
                {selectedShare === "invite" && <div className="mt-2"><ShareQr
                  title={label("邀请加入此服务器", "Invite to this server")}
                  description={label("新用户扫描后打开登录页，并自动使用当前服务器域名。", "Scan to open login with this server domain.")}
                  payload={inviteUrl} copyText={inviteUrl} /></div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Presence selector */}
      <div className="flex gap-2 flex-wrap">
        {PRESENCES.map((p) => (
          <button
            key={p.value}
            onClick={() => {
              updatePresence(account.id, p.value);
              updateStatusText(account.id, statusText.trim());
              const client = getClient(account.id);
              if (client?.connected) {
                client.setPresence(p.value, statusText.trim() || undefined);
              }
            }}
            className={clsx(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-all",
              account.presence === p.value
                ? "border-default bg-surface-800/60 text-surface-50"
                : "border-subtle text-surface-200/40 hover:border-default hover:text-surface-200"
            )}
          >
            <span className={clsx("w-2 h-2 rounded-full", p.color)} />
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={statusText}
          onChange={(e) => setStatusText(e.target.value)}
          className="input-field text-xs py-1.5 flex-1"
          placeholder={t("account.statusPlaceholder")}
        />
        <button
          onClick={() => {
            const client = getClient(account.id);
            if (!client?.connected) return;
            const nextStatus = statusText.trim();
            updateStatusText(account.id, nextStatus);
            client.setPresence(account.presence, nextStatus || undefined);
            toast.success(t("account.statusUpdated"));
          }}
          className="btn-ghost text-xs py-1.5 px-2.5"
        >
          {t("common.apply")}
        </button>
      </div>

      <div className="flex gap-2">
        {!account.connected ? (
          <button onClick={connect} disabled={connecting} className="btn-primary text-xs py-1.5 flex items-center gap-1.5">
            {connecting
              ? <span className="w-3 h-3 border border-default border-t-white rounded-full animate-spin" />
              : <Wifi size={12} />
            }
            {t("account.connect")}
          </button>
        ) : (
          <button onClick={disconnect} className="btn-ghost text-xs py-1.5 flex items-center gap-1.5 text-danger">
            <WifiOff size={12} /> {t("account.disconnect")}
          </button>
        )}
        <button
          onClick={handleRemove}
          disabled={removing}
          className="btn-ghost text-xs py-1.5 flex items-center gap-1.5 text-danger ml-auto"
        >
          <Trash2 size={12} /> {t("account.remove")}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [settingsGroup, setSettingsGroup] = useState<"account" | "messaging" | "appearance">("account");
  const { t } = useLanguage();
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const addAccount = useAccountStore((s) => s.addAccount);
  const setConnected = useAccountStore((s) => s.setConnected);
  const soundEnabled = useNotificationStore((s) => s.soundEnabled);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushPending, setPushPending] = useState(false);
  const [pushResult, setPushResult] = useState<"enabled" | "failed" | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [ntfyInfo, setNtfyInfo] = useState<NtfyStatus>({ enabled: false });
  const [ntfyPending, setNtfyPending] = useState(false);
  const [ntfyError, setNtfyError] = useState<string | null>(null);
  const [showPushInstallGuide, setShowPushInstallGuide] = useState(false);
  const pushBrowser = collectBrowserCapabilities();

  useEffect(() => {
    let cancelled = false;
    isPushSupported().then((supported) => {
      if (cancelled) return;
      setPushSupported(supported);
      if (supported) {
        isPushSubscribed().then((subscribed) => {
          if (!cancelled) setPushEnabled(subscribed);
        });
      }
    });
    return () => { cancelled = true; };
  }, [activeAccountId]);

  useEffect(() => {
    let cancelled = false;
    setNtfyInfo({ enabled: false });
    if (activeAccountId) {
      getNtfyStatus(activeAccountId).then((status) => {
        if (!cancelled) setNtfyInfo(status);
      }).catch(() => {
        if (!cancelled) setNtfyError(t("settings.ntfyStatusFailed"));
      });
    }
    return () => { cancelled = true; };
  }, [activeAccountId, t]);

  const handleNtfyChange = async (checked: boolean) => {
    if (!activeAccountId || ntfyPending) return;
    setNtfyPending(true);
    setNtfyError(null);
    try {
      if (checked) {
        setNtfyInfo(await enableNtfy(activeAccountId));
      } else if (ntfyInfo.enabled) {
        await disableNtfy(activeAccountId, ntfyInfo.node);
        setNtfyInfo({ enabled: false });
      }
    } catch (error) {
      setNtfyError(error instanceof Error ? error.message.slice(0, 180) : t("settings.ntfyFailed"));
    } finally {
      setNtfyPending(false);
    }
  };

  const handlePushChange = (checked: boolean) => {
    setPushResult(null);
    setPushError(null);
    if (checked && pushBrowser.isIOS && !pushBrowser.isStandalonePwa) {
      setShowPushInstallGuide(true);
      return;
    }
    void handleTogglePush(checked);
  };

  const handleTogglePush = async (checked: boolean) => {
    setPushPending(true);
    try {
      if (checked) {
        const ok = await subscribeToPush();
        setPushEnabled(ok);
        setPushResult(ok ? "enabled" : "failed");
        if (!ok) toast.error(t("toast.pushFailed"));
        else toast.success(t("toast.pushEnabled"));
      } else {
        const ok = await unsubscribeFromPush();
        setPushEnabled(!ok);
        if (ok) toast.success(t("toast.pushDisabled"));
        else toast.error(t("toast.pushFailed"));
      }
    } catch (error) {
      setPushEnabled(!checked);
      setPushResult("failed");
      setPushError(error instanceof Error ? error.message.slice(0, 240) : "Unknown error");
      toast.error(t("toast.pushFailed"));
    } finally {
      setPushPending(false);
    }
  };
  const browserEnabled = useNotificationStore((s) => s.browserEnabled);
  const setSoundEnabled = useNotificationStore((s) => s.setSoundEnabled);
  const setBrowserEnabled = useNotificationStore((s) => s.setBrowserEnabled);
  const [searchParams, setSearchParams] = useSearchParams();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ jid: "", password: "", wsUrl: "" });
  const [passwordForm, setPasswordForm] = useState({ old: "", next: "", confirm: "" });
  const [passwordPending, setPasswordPending] = useState(false);
  const handlePasswordChange = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeAccountId || passwordPending) return;
    if (passwordForm.next.length < 6 || passwordForm.next !== passwordForm.confirm) {
      toast.error(t("settings.passwordMismatch"));
      return;
    }
    setPasswordPending(true);
    try {
      const jid = accounts.find((account) => account.id === activeAccountId)?.jid;
      if (!jid) throw new Error("Account unavailable");
      await authApi.changePassword(passwordForm.old, passwordForm.next);
      setAccountPassword(activeAccountId, passwordForm.next);
      const session = await authApi.getUserToken(jid, passwordForm.next);
      setUserToken(activeAccountId, session.access_token);
      if (session.refresh_token) setUserRefreshToken(activeAccountId, session.refresh_token);
      setPasswordForm({ old: "", next: "", confirm: "" });
      toast.success(t("settings.passwordChanged"));
    } catch {
      toast.error(t("settings.passwordChangeFailed"));
    } finally {
      setPasswordPending(false);
    }
  };
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme());
  const [language, setLanguageState] = useState<Language>(getStoredLanguage());
  const [historyRetentionDays, setHistoryRetentionDays] = useState<number>(() => {
    const saved = getStoredHistoryRetentionDays();
    return HISTORY_RETENTION_OPTIONS.includes(saved) ? saved : 0;
  });
  const [notifyMentionEnabled, setNotifyMentionEnabled] = useState<boolean>(() => localStorage.getItem(MENTION_NOTIFY_KEY) !== "0");
  const [messageDensity, setMessageDensity] = useState<MessageDensity>(() => {
    const raw = localStorage.getItem(DENSITY_KEY);
    return raw === "compact" ? "compact" : "comfortable";
  });
  const [omemoFingerprints, setOmemoFingerprints] = useState<Record<string, string>>({});
  const [copiedAccountId, setCopiedAccountId] = useState<string | null>(null);
  const [omemoEnabled, setOmemoEnabledState] = useState<boolean>(getOmemoEnabled());

  useEffect(() => {
    if (searchParams.get("add") === "1") {
      setShowAdd(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const entries = await Promise.all(
        accounts.map(async (acc) => {
          await initializeOmemoKeys(acc.id);
          return [acc.id, await getIdentityFingerprint(acc.id)] as const;
        })
      );
      if (!cancelled) setOmemoFingerprints(Object.fromEntries(entries));
    };
    run().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accounts]);

  useEffect(() => onOmemoEnabledChange(setOmemoEnabledState), []);

  useEffect(() => {
    localStorage.setItem(MENTION_NOTIFY_KEY, notifyMentionEnabled ? "1" : "0");
  }, [notifyMentionEnabled]);

  useEffect(() => {
    localStorage.setItem(DENSITY_KEY, messageDensity);
    document.documentElement.classList.toggle("density-compact", messageDensity === "compact");
  }, [messageDensity]);

  useEffect(() => {
    if (!activeAccountId) return;
    accountsApi
      .getPreferences(activeAccountId)
      .then((pref) => {
        if (typeof pref?.theme_override === "string" && pref.theme_override) {
          const savedTheme = pref.theme_override as ThemeMode;
          setTheme(savedTheme);
          applyTheme(savedTheme);
        }
        if (typeof pref?.notifications_enabled === "boolean") {
          setBrowserEnabled(pref.notifications_enabled);
        }
      })
      .catch(() => {});
  }, [activeAccountId, setBrowserEnabled]);

  const syncPreferencesPatch = async (patch: Record<string, any>) => {
    if (!activeAccountId) return;
    try {
      await accountsApi.updatePreferences(activeAccountId, patch);
    } catch {
      // keep UX responsive even if backend is temporarily unavailable
    }
  };

  const handleAdd = async () => {
    if (!form.jid || !form.password) { toast.error(t("toast.jidRequired")); return; }
    const jid = normalizeAccountJid(form.jid);
    try { requireLocalXmppAccount(jid); } catch (error: any) { toast.error(error.message); return; }
    const existing = useAccountStore.getState().accounts.find((a) => normalizeAccountJid(a.jid) === jid);
    const id = existing?.id ?? crypto.randomUUID();
    addAccount({
      id,
      jid,
      domain: jid.split("@")[1] ?? "localhost",
      password: form.password,
      displayName: jid.split("@")[0],
    });
    setAccountPassword(id, form.password);
    try {
      const client = createClient({
        jid,
        password: form.password,
        wsUrl: deriveSameOriginWsUrl(import.meta.env.VITE_XMPP_WS_URL as string | undefined),
        accountId: id,
      });
      initXmppBridge(client);
      client.on("connection.changed", (d: any) => setConnected(id, d.status === "connected"));
      await client.connect();
      accountsApi.create({ jid, domain: jid.split("@")[1] ?? "localhost" }).catch(() => {});
      const tokenRes = await authApi.getUserToken(jid, form.password).catch(() => null);
      if (tokenRes?.access_token) {
        setUserToken(id, tokenRes.access_token);
        if ((tokenRes as any).refresh_token) {
          setUserRefreshToken(id, (tokenRes as any).refresh_token);
        }
      }
      apiSocket.connect(id);
    } catch (error: any) {
      toast.error(error?.message ?? t("toast.connectionFailed"));
    }
    setForm({ jid: "", password: "", wsUrl: "" });
    setShowAdd(false);
    toast.success(t("toast.accountAdded"));
  };

  const handleChangeHistoryRetention = async (days: number) => {
    setHistoryRetentionDays(days);
    setStoredHistoryRetentionDays(days);
    await applyHistoryRetention(days);
    toast.success(t("settings.historyRetentionSaved"));
  };

  const handleClearHistory = async () => {
    if (!window.confirm(t("settings.clearHistoryConfirm"))) return;
    try {
      await clearAllHistoryNow();
      toast.success(t("settings.historyCleared"));
    } catch (error: any) {
      toast.error(error?.message ?? t("settings.copyFailed"));
    }
  };

  const handleCopyFingerprint = async (accountId: string, fingerprint: string) => {
    try {
      await navigator.clipboard.writeText(fingerprint.replace(/\s+/g, ""));
      setCopiedAccountId(accountId);
      toast.success(t("settings.omemoFingerprintCopied"));
      window.setTimeout(() => {
        setCopiedAccountId((prev) => (prev === accountId ? null : prev));
      }, 1400);
    } catch {
      toast.error(t("settings.copyFailed"));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-bold text-surface-50">{t("settings.title")}</h1>
          <p className="text-sm text-surface-200/50 mt-1">{t("settings.subtitle")}</p>
        </div>

        <nav className="grid grid-cols-3 gap-1 rounded-xl border border-subtle bg-surface-900/60 p-1" aria-label={t("settings.title")}>
          {([
            { id: "account" as const, label: t("settings.groupAccount") },
            { id: "messaging" as const, label: t("settings.groupMessaging") },
            { id: "appearance" as const, label: t("settings.groupAppearance") },
          ]).map(({ id, label }) => (
            <button key={id} type="button" onClick={() => setSettingsGroup(id)} aria-pressed={settingsGroup === id}
              className={clsx("rounded-lg px-2 py-2.5 text-xs sm:text-sm font-medium transition-colors",
                settingsGroup === id ? "bg-accent/15 text-accent-soft" : "text-surface-200/60 hover-surface")}>
              {label}
            </button>
          ))}
        </nav>

        {/* Accounts section */}
        <section className={settingsGroup === "account" ? "" : "hidden"}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-surface-200 uppercase tracking-wide">
              {t("settings.accounts")}
            </h2>
            <button onClick={() => setShowAdd(!showAdd)} className="btn-ghost text-xs flex items-center gap-1">
              <Plus size={12} /> {t("settings.addAccount")}
            </button>
          </div>

          {showAdd && (
            <div className="glass rounded-xl p-4 mb-3 flex flex-col gap-3 animate-fade-in">
              <h3 className="text-sm font-medium text-surface-50">{t("settings.addNewAccount")}</h3>
              <input className="input-field text-sm" placeholder="user@xmpp.example.com"
                value={form.jid} onChange={(e) => setForm({ ...form, jid: e.target.value })}
                autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <input className="input-field text-sm" type="password" placeholder={t("settings.password")}
                value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="new-password" spellCheck={false} />
              <div className="flex gap-2">
                <button onClick={handleAdd} className="btn-primary text-sm">{t("settings.add")}</button>
                <button onClick={() => setShowAdd(false)} className="btn-ghost text-sm">{t("settings.cancel")}</button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {accounts.length === 0 ? (
              <p className="text-sm text-surface-200/30 py-4 text-center">{t("settings.noAccounts")}</p>
            ) : (
              accounts.map((acc) => <AccountCard key={acc.id} account={acc} />)
            )}
          </div>
        </section>

        {/* Appearance */}
        <section className={settingsGroup === "account" && activeAccountId ? "" : "hidden"}>
          <form onSubmit={handlePasswordChange} className="glass rounded-xl p-4 flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-surface-50">{t("settings.changePassword")}</h2>
            <input className="input-field text-sm" type="password" autoComplete="current-password" required placeholder={t("settings.currentPassword")} value={passwordForm.old} onChange={(e) => setPasswordForm({ ...passwordForm, old: e.target.value })} />
            <input className="input-field text-sm" type="password" autoComplete="new-password" required minLength={6} placeholder={t("settings.newPassword")} value={passwordForm.next} onChange={(e) => setPasswordForm({ ...passwordForm, next: e.target.value })} />
            <input className="input-field text-sm" type="password" autoComplete="new-password" required placeholder={t("settings.confirmPassword")} value={passwordForm.confirm} onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })} />
            <button type="submit" className="btn-primary text-sm" disabled={passwordPending}>{t("settings.changePassword")}</button>
          </form>
        </section>

        {/* Appearance */}
        <section className={settingsGroup === "appearance" ? "" : "hidden"}>
          <h2 className="text-sm font-semibold text-surface-200 uppercase tracking-wide mb-3">
            {t("settings.appearance")}
          </h2>
          <div className="glass rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-surface-200">{t("settings.theme")}</span>
              <select
                className="input-field w-auto text-sm"
                value={theme}
                onChange={(e) => {
                  const next = e.target.value as ThemeMode;
                  setTheme(next);
                  applyTheme(next);
                  syncPreferencesPatch({ theme_override: next });
                }}
              >
                <option value="dark">{t("settings.themeDark")}</option>
                <option value="light">{t("settings.themeLight")}</option>
                <option value="system">{t("settings.themeSystem")}</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-surface-200">{t("settings.languagePack")}</span>
              <select
                className="input-field w-auto text-sm"
                value={language}
                onChange={(e) => {
                  const next = e.target.value as Language;
                  setLanguageState(next);
                  setLanguage(next);
                }}
              >
                <option value="en-US">{t("settings.languageEn")}</option>
                <option value="zh-CN">{t("settings.languageZh")}</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-surface-200">{t("settings.messageDensity")}</span>
              <select
                className="input-field w-auto text-sm"
                value={messageDensity}
                onChange={(e) => setMessageDensity(e.target.value as MessageDensity)}
              >
                <option value="comfortable">{t("settings.densityComfortable")}</option>
                <option value="compact">{t("settings.densityCompact")}</option>
              </select>
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className={settingsGroup === "messaging" ? "" : "hidden"}>
          <h2 className="text-sm font-semibold text-surface-200 uppercase tracking-wide mb-3">
            {t("settings.notifications")}
          </h2>
          <div className="glass rounded-xl p-4 flex flex-col gap-3">
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="flex flex-col">
                <span className="text-sm text-surface-200"><PlatformTitle title={t("settings.ntfyTitle")} platform={t("settings.ntfyPlatform")} color="text-success" /></span>
                <span className="text-xs text-surface-200/50">{t("settings.ntfyHint")}</span>
              </span>
              <input type="checkbox" checked={ntfyInfo.enabled} disabled={!activeAccountId || ntfyPending}
                onChange={(event) => void handleNtfyChange(event.target.checked)}
                className="w-4 h-4 accent-[#7c6af7]" />
            </label>
            {ntfyPending && <p role="status" className="text-xs text-surface-200">{t("settings.ntfyPending")}</p>}
            {ntfyError && <p role="alert" className="break-words text-xs text-danger">{ntfyError}</p>}
            {ntfyInfo.enabled && (
              <div className="flex flex-col gap-2 border-t border-subtle pt-3">
                <p className="text-xs text-surface-200/70">{t("settings.ntfyInstructions")}</p>
                <div className="flex items-center gap-2 rounded-lg border-default bg-surface-800/40 p-3">
                  <span className="min-w-0 flex-1 break-all font-mono text-sm text-surface-100">{ntfyInfo.topic}</span>
                  <button type="button" className="btn-ghost shrink-0 p-2" aria-label={t("common.copy")}
                    onClick={() => void navigator.clipboard.writeText(ntfyInfo.topic).then(() => toast.success(t("settings.copied"))).catch(() => toast.error(t("settings.copyFailed")))}>
                    <Copy size={16} />
                  </button>
                </div>
                <button type="button" className="btn-ghost self-start text-xs" disabled={ntfyPending}
                  onClick={() => {
                    if (!activeAccountId) return;
                    void testNtfy(activeAccountId).then(() => toast.success(t("settings.ntfyTestSent")))
                      .catch(() => toast.error(t("settings.ntfyFailed")));
                  }}>{t("settings.ntfyTest")}</button>
                <p className="text-xs text-surface-200/50">{t("settings.ntfyAndroidHint")}</p>
              </div>
            )}
            {(pushSupported || pushBrowser.isIOS) && (
              <label className="flex items-center justify-between cursor-pointer">
                <div className="flex flex-col">
                  <span className="text-sm text-surface-200"><PlatformTitle title={t("settings.notifyPush")} platform={t("settings.pushPlatform")} color="text-danger" /></span>
                  <span className="text-xs text-surface-200/40">
                    {pushBrowser.isIOS && !pushBrowser.isStandalonePwa
                      ? t("settings.iosPushInstallHint")
                      : t("settings.notifyPushHint")}
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={pushEnabled}
                  disabled={pushPending}
                  onChange={(e) => handlePushChange(e.target.checked)}
                  className="w-4 h-4 accent-[#7c6af7]"
                />
              </label>
            )}
            {pushPending && <p role="status" className="text-xs text-surface-200">{t("settings.pushPending")}</p>}
            {pushResult && <p role={pushResult === "failed" ? "alert" : "status"} className="text-xs text-surface-200">{t(pushResult === "failed" ? "toast.pushFailed" : "toast.pushEnabled")}</p>}
            {pushError && <p role="alert" className="break-words text-xs text-danger">{pushError}</p>}
            {showPushInstallGuide && pushBrowser.isIOS && !pushBrowser.isStandalonePwa && (
              <div role="note" className="rounded-lg border border-[#7c6af7]/40 bg-[#7c6af7]/10 p-3 text-xs text-surface-200">
                <p className="font-medium">{t("settings.iosPushGuideTitle")}</p>
                <ol className="mt-2 list-decimal space-y-1 pl-4">
                  <li>{t("settings.iosPushGuideInstall")}</li>
                  <li>{t("settings.iosPushGuideOpen")}</li>
                  <li>{t("settings.iosPushGuideAllow")}</li>
                </ol>
              </div>
            )}
            {[
              { label: t("settings.notifyBrowser"), key: "browser" },
              { label: t("settings.notifySound"), key: "sound" },
              { label: t("settings.notifyMention"), key: "mention" },
            ].map(({ label, key }) => (
              <label key={key} className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-surface-200">{label}</span>
                <input
                  type="checkbox"
                  checked={key === "browser" ? browserEnabled : key === "sound" ? soundEnabled : notifyMentionEnabled}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    if (key === "browser") {
                      setBrowserEnabled(checked);
                      syncPreferencesPatch({ notifications_enabled: checked });
                    } else if (key === "sound") {
                      setSoundEnabled(checked);
                    } else {
                      setNotifyMentionEnabled(checked);
                    }
                  }}
                  className="w-4 h-4 accent-[#7c6af7]"
                />
              </label>
            ))}
          </div>
        </section>

        {/* Message history */}
        <section className={settingsGroup === "messaging" ? "" : "hidden"}>
          <h2 className="text-sm font-semibold text-surface-200 uppercase tracking-wide mb-3">
            {t("settings.history")}
          </h2>
          <div className="glass rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-surface-200">{t("settings.historyRetention")}</span>
              <select
                className="input-field w-auto text-sm"
                value={historyRetentionDays}
                onChange={(e) => handleChangeHistoryRetention(Number(e.target.value))}
              >
                <option value={1}>{t("settings.historyRetention1Day")}</option>
                <option value={3}>{t("settings.historyRetention3Days")}</option>
                <option value={7}>{t("settings.historyRetention1Week")}</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-surface-200">{t("settings.clearHistory")}</span>
              <button onClick={handleClearHistory} className="btn-ghost text-xs py-1.5 px-3 text-danger">
                {t("settings.clearHistory")}
              </button>
            </div>
          </div>
        </section>

        {/* OMEMO */}
        <section className={settingsGroup === "account" ? "" : "hidden"}>
          <h2 className="text-sm font-semibold text-surface-200 uppercase tracking-wide mb-3">
            {t("settings.omemo")}
          </h2>
          <div className="glass rounded-xl p-4 flex flex-col gap-3">
            <div className="text-xs text-surface-200/60">{t("settings.omemoDesc")}</div>
            <div className="text-xs text-surface-200/50">
              {omemoEnabled ? t("settings.omemoStatusOn") : t("settings.omemoStatusOff")}
            </div>
            {accounts.length === 0 ? (
              <p className="text-sm text-surface-200/30 py-2 text-center">{t("settings.noAccounts")}</p>
            ) : (
              accounts.map((acc) => {
                const fingerprint = omemoFingerprints[acc.id] ?? "-";
                const copied = copiedAccountId === acc.id;
                return (
                  <div key={acc.id} className="rounded-lg border-default bg-surface-800/40 p-3 flex flex-col gap-2">
                    <div className="text-xs text-surface-200/70">{acc.jid}</div>
                    <div className="font-mono text-xs tracking-wide text-surface-50 break-all">{fingerprint}</div>
                    <div className="flex justify-end">
                      <button
                        onClick={() => handleCopyFingerprint(acc.id, fingerprint)}
                        disabled={!omemoEnabled}
                        className="btn-ghost text-xs py-1.5 px-2.5 flex items-center gap-1.5"
                      >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? t("settings.copied") : t("settings.copyFingerprint")}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <p className="text-xs text-surface-200/20 text-center">Lyao Talk · v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}
