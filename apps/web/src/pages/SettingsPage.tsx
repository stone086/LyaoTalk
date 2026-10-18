import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { getAccountPassword, normalizeAccountJid, setAccountPassword, useAccountStore, XmppAccount, PresenceType } from "@/stores/accountStore";
import { createClient, destroyClient } from "@/services/xmppAdapter";
import { getClient } from "@/services/xmppAdapter";
import { initXmppBridge } from "@/services/xmppBridge";
import { Trash2, Plus, Wifi, WifiOff, Copy, Check, QrCode } from "lucide-react";
import toast from "react-hot-toast";
import { clsx } from "clsx";
import { applyTheme, getStoredTheme, ThemeMode } from "@/utils/theme";
import { getStoredLanguage, Language, setLanguage, useLanguage } from "@/utils/i18n";
import { applyHistoryRetention, clearAllHistoryNow, getStoredHistoryRetentionDays, setStoredHistoryRetentionDays } from "@/services/historyRetention";
import { getOmemoFingerprintForJid } from "@/services/omemoFingerprint";
import { getOmemoEnabled, onOmemoEnabledChange } from "@/services/omemoSettings";
import { useNotificationStore } from "@/stores/notificationStore";
import { accountsApi, authApi, setUserToken, setUserRefreshToken } from "@/services/api";
import Avatar from "@/components/Avatar";
import { apiSocket } from "@/services/apiSocket";
import { isPushSubscribed, isPushSupported, subscribeToPush, unsubscribeFromPush } from "@/services/push";
import { collectBrowserCapabilities } from "@/services/browserCompatibility";
import { markIntentionalDisconnect } from "@/services/connectionSupervisor";
import { logoutAccount } from "@/services/logoutAccount";
import { isLocalXmppJid, resolveXmppWsUrl } from "@/services/xmppEndpoint";

const MENTION_NOTIFY_KEY = "liaot-notify-mention";
const DENSITY_KEY = "liaot-message-density";
const HISTORY_RETENTION_OPTIONS = [0, 1, 3, 7, 30];
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
      width: 144,
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
    <div className="min-w-0 rounded-lg border-default bg-surface-800/40 p-3 flex flex-col sm:flex-row gap-3 overflow-hidden">
      <div className="w-36 h-36 shrink-0 rounded-md bg-white flex items-center justify-center">
        <canvas
          ref={qrCanvasRef}
          aria-label={title}
          className={clsx("block max-w-full max-h-full", !qrReady && "hidden")}
        />
        {!qrReady && (
          <QrCode size={28} className="text-surface-900" />
        )}
      </div>
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        <div>
          <div className="text-xs font-semibold text-surface-50">{title}</div>
          <div className="text-[11px] text-surface-200/45 leading-relaxed">{description}</div>
        </div>
        <div className="font-mono text-[11px] text-surface-200/60 break-all">{copyText}</div>
        <button onClick={copy} className="btn-ghost text-xs py-1.5 px-2.5 flex items-center gap-1.5 self-start">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t("settings.copied") : t("common.copy")}
        </button>
      </div>
    </div>
  );
}

function AccountCard({ account }: { account: XmppAccount }) {
  const { lang, t } = useLanguage();
  const navigate = useNavigate();
  const updatePresence = useAccountStore((s) => s.updatePresence);
  const setConnected = useAccountStore((s) => s.setConnected);
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [statusText, setStatusText] = useState("");
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

  const connect = async () => {
    setConnecting(true);
    try {
      const runtimePassword = getAccountPassword(account.id);
      if (!runtimePassword) {
        toast.error("Password not available in this session. Please sign in again.");
        navigate(`/login?jid=${encodeURIComponent(account.jid)}`);
        return;
      }
      const client = createClient({
        jid: account.jid,
        password: runtimePassword,
        wsUrl: await resolveXmppWsUrl(account.jid, account.wsUrl),
        accountId: account.id,
      });
      initXmppBridge(client);
      client.on("connection.changed", (d: any) => setConnected(account.id, d.status === "connected"));
      await client.connect();
      if (isLocalXmppJid(account.jid)) accountsApi.create({ jid: account.jid, domain: account.jid.split("@")[1] ?? "localhost" }).catch(() => {});
      const tokenRes = isLocalXmppJid(account.jid) ? await authApi.getUserToken(account.jid, runtimePassword).catch(() => null) : null;
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
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="glass rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Avatar name={account.displayName ?? account.jid} size="md" presence={account.presence} />
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
        </div>
      </div>

      {/* Presence selector */}
      <div className="flex gap-2 flex-wrap">
        {PRESENCES.map((p) => (
          <button
            key={p.value}
            onClick={() => {
              updatePresence(account.id, p.value);
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
            client.setPresence(account.presence, statusText.trim() || undefined);
            toast.success(t("account.statusUpdated"));
          }}
          className="btn-ghost text-xs py-1.5 px-2.5"
        >
          {t("common.apply")}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ShareQr
          title={label("添加我为联系人", "Add me as a contact")}
          description={label("联系人扫描后会打开 Lyao Talk 并添加你的 XMPP 地址。", "Scan to open Lyao Talk and add this XMPP address.")}
          payload={contactUrl}
          copyText={bareJid}
        />
        <ShareQr
          title={label("邀请加入此服务器", "Invite to this server")}
          description={label("新用户扫描后打开登录页，并自动使用当前服务器域名。", "Scan to open login with this server domain.")}
          payload={inviteUrl}
          copyText={inviteUrl}
        />
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
  const { t } = useLanguage();
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const addAccount = useAccountStore((s) => s.addAccount);
  const setConnected = useAccountStore((s) => s.setConnected);
  const soundEnabled = useNotificationStore((s) => s.soundEnabled);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
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

  const handlePushChange = (checked: boolean) => {
    if (checked && pushBrowser.isIOS && !pushBrowser.isStandalonePwa) {
      setShowPushInstallGuide(true);
      return;
    }
    void handleTogglePush(checked);
  };

  const handleTogglePush = async (checked: boolean) => {
    try {
      if (checked) {
        const ok = await subscribeToPush();
        setPushEnabled(ok);
        if (!ok) toast.error(t("toast.pushFailed"));
        else toast.success(t("toast.pushEnabled"));
      } else {
        const ok = await unsubscribeFromPush();
        setPushEnabled(!ok);
        if (ok) toast.success(t("toast.pushDisabled"));
        else toast.error(t("toast.pushFailed"));
      }
    } catch {
      setPushEnabled(!checked);
      toast.error(t("toast.pushFailed"));
    }
  };
  const browserEnabled = useNotificationStore((s) => s.browserEnabled);
  const setSoundEnabled = useNotificationStore((s) => s.setSoundEnabled);
  const setBrowserEnabled = useNotificationStore((s) => s.setBrowserEnabled);
  const [searchParams, setSearchParams] = useSearchParams();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ jid: "", password: "", wsUrl: "" });
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
        accounts.map(async (acc) => [acc.id, await getOmemoFingerprintForJid(acc.jid, acc.id)] as const)
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
    const existing = useAccountStore.getState().accounts.find((a) => normalizeAccountJid(a.jid) === jid);
    const id = existing?.id ?? crypto.randomUUID();
    let wsUrl: string;
    try {
      wsUrl = await resolveXmppWsUrl(jid, form.wsUrl || existing?.wsUrl);
    } catch (error: any) {
      toast.error(error?.message ?? t("toast.connectionFailed"));
      return;
    }
    addAccount({
      id,
      jid,
      domain: jid.split("@")[1] ?? "localhost",
      wsUrl,
      password: form.password,
      displayName: jid.split("@")[0],
    });
    setAccountPassword(id, form.password);
    try {
      const client = createClient({
        jid,
        password: form.password,
        wsUrl,
        accountId: id,
      });
      initXmppBridge(client);
      client.on("connection.changed", (d: any) => setConnected(id, d.status === "connected"));
      await client.connect();
      if (isLocalXmppJid(jid)) accountsApi.create({ jid, domain: jid.split("@")[1] ?? "localhost" }).catch(() => {});
      const tokenRes = isLocalXmppJid(jid) ? await authApi.getUserToken(jid, form.password).catch(() => null) : null;
      if (tokenRes?.access_token) {
        setUserToken(id, tokenRes.access_token);
        if ((tokenRes as any).refresh_token) {
          setUserRefreshToken(id, (tokenRes as any).refresh_token);
        }
      }
      if (isLocalXmppJid(jid)) apiSocket.connect(id);
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

        {/* Accounts section */}
        <section>
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
              <input className="input-field text-sm" placeholder={t("settings.wsOptional")}
                value={form.wsUrl} onChange={(e) => setForm({ ...form, wsUrl: e.target.value })} />
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
        <section>
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
        <section>
          <h2 className="text-sm font-semibold text-surface-200 uppercase tracking-wide mb-3">
            {t("settings.notifications")}
          </h2>
          <div className="glass rounded-xl p-4 flex flex-col gap-3">
            {(pushSupported || pushBrowser.isIOS) && (
              <label className="flex items-center justify-between cursor-pointer">
                <div className="flex flex-col">
                  <span className="text-sm text-surface-200">{t("settings.notifyPush")}</span>
                  <span className="text-xs text-surface-200/40">
                    {pushBrowser.isIOS && !pushBrowser.isStandalonePwa
                      ? t("settings.iosPushInstallHint")
                      : t("settings.notifyPushHint")}
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={pushEnabled}
                  onChange={(e) => handlePushChange(e.target.checked)}
                  className="w-4 h-4 accent-[#7c6af7]"
                />
              </label>
            )}
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
        <section>
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
        <section>
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
