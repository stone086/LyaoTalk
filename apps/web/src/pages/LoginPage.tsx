import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { normalizeAccountJid, setAccountPassword, useAccountStore } from "@/stores/accountStore";
import { createClient } from "@/services/xmppAdapter";
import { initXmppBridge } from "@/services/xmppBridge";
import { markIntentionalDisconnect } from "@/services/connectionSupervisor";
import { accountsApi, authApi, setUserToken, setUserRefreshToken, clearUserToken } from "@/services/api";
import { apiSocket } from "@/services/apiSocket";
import toast from "react-hot-toast";
import { Wifi, Eye, EyeOff, UserPlus } from "lucide-react";
import { useLanguage } from "@/utils/i18n";
import { requireLocalXmppAccount } from "@/services/localXmppAccount";
import { restoreLocalAccountHistory } from "@/services/localDb";

export default function LoginPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const addAccount = useAccountStore((s) => s.addAccount);
  const setConnected = useAccountStore((s) => s.setConnected);
  const currentHost = window.location.hostname.trim().toLowerCase();
  const configuredWsUrl = (import.meta.env.VITE_XMPP_WS_URL as string | undefined) ?? "";
  const wsUrl = (() => {
    const sameOrigin = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/xmpp-websocket`;
    if (!configuredWsUrl) return sameOrigin;
    try {
      return new URL(configuredWsUrl).host === window.location.host ? configuredWsUrl : sameOrigin;
    } catch {
      return sameOrigin;
    }
  })();
  const envXmppDomain = ((import.meta.env.VITE_XMPP_DOMAIN as string | undefined) ?? "").trim().toLowerCase();

  const [form, setForm] = useState({
    jid: (new URLSearchParams(window.location.search).get("jid") ?? "").split("@")[0],
    password: "",
  });
  const [inviteDomain] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get("invite_domain") ?? "").trim().toLowerCase();
  });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [xmppDomain, setXmppDomain] = useState(envXmppDomain);
  const [publicDomain, setPublicDomain] = useState(currentHost);
  const isLocalDomain = (value: string) => {
    const v = (value || "").trim().toLowerCase();
    return v === "localhost" || v === "127.0.0.1" || v === "::1";
  };
  const effectiveXmppDomain =
    !isLocalDomain(xmppDomain) ? xmppDomain :
    !isLocalDomain(envXmppDomain) ? envXmppDomain :
    !isLocalDomain(currentHost) ? currentHost :
    xmppDomain;
  const loginDomain = effectiveXmppDomain || envXmppDomain || currentHost;

  const expandJid = (value: string) => {
    const trimmed = value.trim();
    if (loginDomain && trimmed && !trimmed.includes("@")) return `${trimmed}@${loginDomain}`;
    if (!effectiveXmppDomain || !trimmed.includes("@")) return trimmed;

    const [username, ...domainParts] = trimmed.split("@");
    const domain = domainParts.join("@").toLowerCase();
    const aliases = new Set([publicDomain, currentHost].filter(Boolean));
    // Never rewrite a public-domain JID to localhost/loopback.
    if (isLocalDomain(effectiveXmppDomain)) return trimmed;
    if (username && aliases.has(domain) && domain !== effectiveXmppDomain) {
      return `${username}@${effectiveXmppDomain}`;
    }
    return trimmed;
  };

  const withTimeout = <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };

  const connectWithCurrentForm = async (jidOverride?: string) => {
    const jid = normalizeAccountJid(jidOverride ?? expandJid(form.jid));
    requireLocalXmppAccount(jid);
    const domain = jid.split("@")[1] ?? "localhost";
    const existing = useAccountStore.getState().accounts.find((a) => normalizeAccountJid(a.jid) === jid);
    // Prefer the backend account_id when available. A random local id makes
    // REST calls like /accounts/{id}/preferences fail with 403 because the JWT
    // contains the real server-side account_id.
    const tokenRes = await authApi.getUserToken(jid, form.password).catch((tokenErr) => {
      console.warn("REST user token fallback failed; continuing with XMPP session", tokenErr);
      return null;
    });
    const id = tokenRes?.account_id ?? existing?.id ?? crypto.randomUUID();
    const client = createClient({ jid, password: form.password, wsUrl, accountId: id });
    initXmppBridge(client);
    try {
      await withTimeout(client.connect(), 20000, t("login.connectionFailed"));
      addAccount({ id, jid, domain, displayName: jid.split("@")[0] });
      setConnected(id, true);
      void client.fetchPepAvatar(jid).then((avatarUrl) => {
        if (avatarUrl) useAccountStore.getState().updateAvatar(id, avatarUrl);
      }).catch(() => {});
      setAccountPassword(id, form.password);
      clearUserToken(id);
      if (tokenRes?.access_token) {
        setUserToken(id, tokenRes.access_token);
        if ((tokenRes as any).refresh_token) setUserRefreshToken(id, (tokenRes as any).refresh_token);
      }
      try {
        await restoreLocalAccountHistory(id, form.password);
      } catch {
        toast.error(t("login.localHistoryRestoreFailed"));
      }
      toast.success(`${t("login.connectedAs")}: ${jid}`);
      // apiSocket.connect(id);
      navigate("/");
    } catch (err: any) {
      // Mark as intentional so the supervisor (if it was attached) doesn't
      // immediately retry an account that just failed initial auth.
      try {
        markIntentionalDisconnect(id);
      } catch {}
      client.disconnect();
      throw err;
    }
  };

  const [ssoProviders, setSsoProviders] = useState<{ oidc: boolean; ldap: boolean; oidc_label: string; ldap_label: string } | null>(null);
  const [ldapMode, setLdapMode] = useState(false);
  const [ldapUser, setLdapUser] = useState("");
  const [ldapPass, setLdapPass] = useState("");

  // Discover available SSO providers on mount
  useEffect(() => {
    authApi.config()
      .then((config) => {
        if (config?.xmpp_domain) setXmppDomain(String(config.xmpp_domain).trim().toLowerCase());
        if (config?.public_domain) setPublicDomain(String(config.public_domain).trim().toLowerCase());
      })
      .catch(() => {});
    fetch("/sso/providers")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data && (data.oidc || data.ldap)) setSsoProviders(data);
      })
      .catch(() => {});
  }, []);

  // Handle SSO redirect-back-with-code (secure one-time exchange)
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#sso-code=")) {
      const params = new URLSearchParams(hash.slice(1));
      const code = params.get("sso-code");
      if (code) {
        // Exchange one-time code for token
        fetch("/sso/oidc/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        })
          .then(async (r) => {
            if (!r.ok) throw new Error("SSO code exchange failed");
            return r.json();
          })
          .then((data: { access_token: string; refresh_token?: string; jid: string; account_id?: string }) => {
            const jid = normalizeAccountJid(data.jid);
            const existing = useAccountStore.getState().accounts.find((a) => normalizeAccountJid(a.jid) === jid);
            const id = data.account_id ?? existing?.id ?? crypto.randomUUID();
            useAccountStore.getState().addAccount({
              id, jid,
              domain: jid.split("@")[1] ?? "",
              displayName: jid.split("@")[0],
            });
            setUserToken(id, data.access_token);
            if (data.refresh_token) setUserRefreshToken(id, data.refresh_token);
            toast.success("SSO login successful");
            window.history.replaceState(null, "", "/");
            navigate("/");
          })
          .catch((err) => {
            toast.error(err?.message ?? "SSO login failed");
            window.history.replaceState(null, "", "/login");
          });
      }
    }
  }, [navigate]);

  const handleLdapLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ldapUser || !ldapPass) return;
    setLoading(true);
    try {
      const r = await fetch("/sso/ldap/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: ldapUser, password: ldapPass }),
      });
      if (!r.ok) throw new Error((await r.json()).detail ?? "LDAP login failed");
      const data = await r.json();
      const jid = normalizeAccountJid(data.jid);
      const existing = useAccountStore.getState().accounts.find((a) => normalizeAccountJid(a.jid) === jid);
      const id = data.account_id ?? existing?.id ?? crypto.randomUUID();
      useAccountStore.getState().addAccount({
        id, jid,
        domain: jid.split("@")[1] ?? "",
        displayName: ldapUser,
      });
      setUserToken(id, data.access_token);
      if (data.refresh_token) setUserRefreshToken(id, data.refresh_token);
      // (Removed: localStorage.setItem("token", ...) — dead write, see above)

      sessionStorage.setItem(
        `liaot-user-token:${id}`,
        data.access_token
      );
      toast.success("LDAP login successful");
      navigate("/");
    } catch (err: any) {
      toast.error(err?.message ?? "LDAP login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.jid || !form.password) return;
    setLoading(true);
    try {
      await connectWithCurrentForm();
    } catch (err: any) {
      toast.error(err.message ?? t("login.connectionFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!form.jid || !form.password) {
      toast.error(t("toast.jidRequired"));
      return;
    }
    setRegistering(true);
    try {
      const requestedJid = expandJid(form.jid);
      const reg = await authApi.register({ jid: requestedJid, password: form.password });
      const effectiveJid = reg?.jid ?? requestedJid;
      setForm((prev) => ({ ...prev, jid: effectiveJid.split("@")[0] }));
      toast.success(t("login.registerSuccess"));
      await connectWithCurrentForm(effectiveJid);
    } catch (err: any) {
      const message = err?.response?.data?.detail ?? err?.message ?? t("login.registerFailed");
      toast.error(message);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="login-page min-h-screen flex items-center justify-center bg-surface-950 px-4 py-8 sm:py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-5 flex flex-col items-center text-center">
          <img src="/app-logo.png" alt="LyaoTalk" className="mb-4 h-[120px] w-[120px] rounded-2xl object-cover" />
          <h1 className="text-base text-surface-100 sm:text-lg">{t("login.connectAccount")}</h1>
        </div>
        {inviteDomain && (
          <div className="mb-4 rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-surface-100">
            {t("login.inviteHint").replace("{domain}", inviteDomain)}
          </div>
        )}
        <div className="login-shell rounded-[28px] px-5 py-7 shadow-xl sm:flex sm:aspect-[3/2] sm:items-center sm:px-6 sm:py-6">
          <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4 sm:gap-3">
            <div className="flex flex-col gap-2 sm:gap-1.5">
              <label htmlFor="login-username" className="text-sm font-medium text-surface-100 sm:text-base">{t("login.username")}</label>
              <div className="login-input flex w-full items-center gap-2 rounded-xl px-4">
                <input
                  id="login-username"
                  type="text"
                  value={form.jid}
                  onChange={(e) => setForm({ ...form, jid: e.target.value.split("@")[0] })}
                  placeholder={t("login.username")}
                  className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-base text-surface-50 outline-none placeholder:text-surface-200/70"
                  required
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {loginDomain && <span className="shrink-0 whitespace-nowrap text-sm text-surface-100">@{loginDomain}</span>}
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:gap-1.5">
              <label htmlFor="login-password" className="text-sm font-medium text-surface-100 sm:text-base">{t("login.password")}</label>
              <div className="relative">
                <input type={showPass ? "text" : "password"} value={form.password}
                  id="login-password"
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={t("login.password")} className="login-input w-full min-w-0 rounded-xl pl-4 pr-12 text-base text-surface-50 placeholder:text-surface-200/70" required
                  autoComplete="current-password"
                  spellCheck={false}
                />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute inset-y-0 right-1 flex w-10 items-center justify-center rounded-lg text-surface-100 hover:text-surface-50 focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label={showPass ? t("login.hidePassword") : t("login.showPassword")}>
                  {showPass ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:mt-1">
              <button type="submit" disabled={loading || registering} className="btn-primary h-12 rounded-xl flex items-center justify-center gap-2 sm:h-11">
                {loading ? (<><span className="w-4 h-4 border-2 border-default border-t-white rounded-full animate-spin" />{t("login.connecting")}</>) : (<><Wifi size={16} />{t("login.connect")}</>)}
              </button>
              <button
                type="button"
                disabled={loading || registering}
                onClick={handleRegister}
                className="login-secondary h-12 rounded-xl text-surface-50 font-semibold flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed sm:h-11"
              >
                <UserPlus size={16} />
                {registering ? t("login.registering") : t("login.register")}
              </button>
            </div>
          </form>
        </div>
        {ssoProviders && (
            <div className="mt-4">
              <p className="text-xs text-surface-200/40 text-center mb-3">{t("login.ssoDivider")}</p>
              <div className="flex flex-col gap-2">
                {ssoProviders.oidc && (
                  <a
                    href="/sso/oidc/login"
                    className="btn-secondary text-sm text-center py-2 hover-surface"
                  >
                    {ssoProviders.oidc_label}
                  </a>
                )}
                {ssoProviders.ldap && (
                  <button
                    type="button"
                    onClick={() => setLdapMode(!ldapMode)}
                    className="btn-secondary text-sm py-2 hover-surface"
                  >
                    {ssoProviders.ldap_label}
                  </button>
                )}
              </div>
              {ssoProviders.ldap && ldapMode && (
                <form onSubmit={handleLdapLogin} className="flex flex-col gap-2 mt-3">
                  <input
                    type="text"
                    placeholder={t("login.username")}
                    value={ldapUser}
                    onChange={(e) => setLdapUser(e.target.value)}
                    className="input-field text-sm"
                    autoFocus
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <input
                    type="password"
                    placeholder={t("login.password")}
                    value={ldapPass}
                    onChange={(e) => setLdapPass(e.target.value)}
                    className="input-field text-sm"
                    autoComplete="current-password"
                    spellCheck={false}
                  />
                  <button type="submit" disabled={loading} className="btn-primary text-sm py-2">
                    {t("login.ldapSignIn")}
                  </button>
                </form>
              )}
            </div>
        )}
        <p className="text-center text-xs text-surface-200/70 mt-5">Lyao Talk · Open Source · v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}

