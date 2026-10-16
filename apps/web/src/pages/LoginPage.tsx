import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { normalizeAccountJid, setAccountPassword, useAccountStore } from "@/stores/accountStore";
import { createClient } from "@/services/xmppAdapter";
import { initXmppBridge } from "@/services/xmppBridge";
import { markIntentionalDisconnect } from "@/services/connectionSupervisor";
import { accountsApi, authApi, setUserToken, setUserRefreshToken, clearUserToken } from "@/services/api";
import { apiSocket } from "@/services/apiSocket";
import toast from "react-hot-toast";
import { Wifi, Lock, User, Eye, EyeOff, UserPlus } from "lucide-react";
import { useLanguage } from "@/utils/i18n";

export default function LoginPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const addAccount = useAccountStore((s) => s.addAccount);
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
    jid: new URLSearchParams(window.location.search).get("jid") ?? "",
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
    !isLocalDomain(inviteDomain) ? inviteDomain :
    !isLocalDomain(currentHost) ? currentHost :
    xmppDomain;
  const loginDomain = effectiveXmppDomain || inviteDomain || envXmppDomain || currentHost;

  const expandJid = (value: string) => {
    const trimmed = value.trim();
    if (loginDomain && trimmed && !trimmed.includes("@")) return `${trimmed}@${loginDomain}`;
    if (!effectiveXmppDomain || !trimmed.includes("@")) return trimmed;

    const [username, ...domainParts] = trimmed.split("@");
    const domain = domainParts.join("@").toLowerCase();
    const aliases = new Set([inviteDomain, publicDomain, currentHost].filter(Boolean));
    // Never rewrite a public-domain JID to localhost/loopback.
    if (isLocalDomain(effectiveXmppDomain)) return trimmed;
    if (username && aliases.has(domain) && domain !== effectiveXmppDomain) {
      return `${username}@${effectiveXmppDomain}`;
    }
    return trimmed;
  };

  const completeJidInForm = () => {
    setForm((prev) => ({ ...prev, jid: expandJid(prev.jid) }));
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
      setAccountPassword(id, form.password);
      clearUserToken(id);
      if (tokenRes?.access_token) {
        setUserToken(id, tokenRes.access_token);
        if ((tokenRes as any).refresh_token) setUserRefreshToken(id, (tokenRes as any).refresh_token);
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
      setForm((prev) => ({ ...prev, jid: effectiveJid }));
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
    <div className="min-h-screen flex items-center justify-center bg-surface-950 bg-[radial-gradient(ellipse_at_top,rgba(124,106,247,0.08),transparent_60%)]">
      <div className="w-full max-w-md px-4">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-32 h-32 rounded-3xl bg-accent/10 border border-accent/20 mb-4 overflow-hidden">
            <img src="/lyaotalk-original-icon.png" alt="Lyao Talk" className="w-full h-full object-cover" />
          </div>
        </div>
        <div className="glass rounded-2xl p-8 shadow-2xl">
          <h2 className="text-lg font-semibold text-surface-50 mb-6">{t("login.connectAccount")}</h2>
          {inviteDomain && (
            <div className="mb-4 rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-surface-100">
              {t("login.inviteHint").replace("{domain}", inviteDomain)}
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-surface-200/70 uppercase tracking-wide">{t("login.jid")}</label>
              <div className="relative">
                <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-200/30" />
                <input
                  type="text"
                  value={form.jid}
                  onChange={(e) => setForm({ ...form, jid: e.target.value })}
                  onBlur={completeJidInForm}
                  placeholder={loginDomain ? t("login.jidInvitePlaceholder").replace("{domain}", loginDomain) : "user@example.com"}
                  className="input-field pl-9"
                  required
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              {loginDomain && (
                <p className="text-xs text-surface-200/45">
                  {t("login.jidAutoCompleteHint").replace("{domain}", loginDomain)}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-surface-200/70 uppercase tracking-wide">{t("login.password")}</label>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-200/30" />
                <input type={showPass ? "text" : "password"} value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="********" className="input-field pl-9 pr-10" required
                  autoComplete="current-password"
                  spellCheck={false}
                />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-200/30 hover:text-surface-200">
                  {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <button type="submit" disabled={loading || registering} className="btn-primary flex items-center justify-center gap-2">
                {loading ? (<><span className="w-4 h-4 border-2 border-default border-t-white rounded-full animate-spin" />{t("login.connecting")}</>) : (<><Wifi size={16} />{t("login.connect")}</>)}
              </button>
              <button
                type="button"
                disabled={loading || registering}
                onClick={handleRegister}
                className="h-12 rounded-xl border border-surface-100/20 bg-surface-900/40 text-surface-50 font-semibold flex items-center justify-center gap-2 hover:bg-surface-900/60 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <UserPlus size={16} />
                {registering ? t("login.registering") : t("login.register")}
              </button>
            </div>
          </form>
          {ssoProviders && (
            <div className="mt-4 pt-4 border-t border-subtle">
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
        </div>
        <p className="text-center text-xs text-surface-200/20 mt-6">Lyao Talk · Open Source · v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}

