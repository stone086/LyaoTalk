import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ADMIN_SESSION_EXPIRED_EVENT, adminApi, authApi, setAdminRefreshToken, getAdminRefreshToken, clearAdminRefreshToken } from "@/services/api";
import { Shield, Activity, Database, Server, Users, FileText, AlertCircle, CheckCircle } from "lucide-react";
import { clsx } from "clsx";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";

function StatCard({ icon: Icon, label, value, color = "text-surface-50" }: {
  icon: any; label: string; value: string | number; color?: string;
}) {
  return (
    <div className="glass rounded-xl p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-surface-800 flex items-center justify-center flex-shrink-0">
        <Icon size={16} className={color} />
      </div>
      <div>
        <p className="text-xs text-surface-200/50">{label}</p>
        <p className={clsx("text-lg font-bold", color)}>{value}</p>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [authed, setAuthed] = useState(!!sessionStorage.getItem("admin_token"));
  const [creds, setCreds] = useState({ username: "", password: "" });
  const [tab, setTab] = useState<"overview" | "accounts" | "groups" | "push" | "audit">("overview");
  const [accountQuery, setAccountQuery] = useState("");
  const [accountBusy, setAccountBusy] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: ["admin-status"],
    queryFn: adminApi.status,
    enabled: authed,
    refetchInterval: 10000,
  });
  const { data: health } = useQuery({
    queryKey: ["admin-service-health"],
    queryFn: adminApi.serviceHealth,
    enabled: authed,
    refetchInterval: 10000,
  });
  const { data: auditLogs } = useQuery({
    queryKey: ["admin-audit-logs"],
    queryFn: () => adminApi.auditLogs(20, 0),
    enabled: authed,
    refetchInterval: 15000,
  });
  const { data: accounts = [], isLoading: accountsLoading, isError: accountsError } = useQuery({
    queryKey: ["admin-accounts", accountQuery],
    queryFn: () => adminApi.accounts(accountQuery),
    enabled: authed && tab === "accounts",
  });
  const { data: groups = [], isLoading: groupsLoading, isError: groupsError } = useQuery({
    queryKey: ["admin-groups"], queryFn: adminApi.groups, enabled: authed && tab === "groups",
  });
  const { data: pushStatus } = useQuery({
    queryKey: ["admin-push-status"], queryFn: adminApi.pushStatus, enabled: authed && tab === "push",
    refetchInterval: 30000,
  });
  const { data: activity } = useQuery({
    queryKey: ["admin-activity"], queryFn: adminApi.activity, enabled: authed && tab === "overview",
  });
  const { data: storageUsage } = useQuery({
    queryKey: ["admin-storage-usage"], queryFn: adminApi.storageUsage, enabled: authed && tab === "overview",
  });
  const { data: userStats } = useQuery({
    queryKey: ["admin-user-stats"], queryFn: adminApi.userStats, enabled: authed && tab === "overview",
  });

  const setAccountEnabled = async (account: { id: string; jid: string; is_enabled: boolean }) => {
    const action = account.is_enabled ? "停用" : "启用";
    if (window.prompt(`输入 ${account.jid} 确认${action}此账号：`) !== account.jid) return;
    setAccountBusy(account.id);
    try {
      await adminApi.setAccountEnabled(account.id, !account.is_enabled);
      await queryClient.invalidateQueries({ queryKey: ["admin-accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["admin-status"] });
      toast.success(`已${action} ${account.jid}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${action}失败`);
    } finally {
      setAccountBusy(null);
    }
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await adminApi.login(creds.username, creds.password);
      sessionStorage.setItem("admin_token", res.access_token);
      // Persist refresh token so the axios interceptor can renew when the
      // 30-minute access token expires, instead of dropping the admin out.
      if ((res as any).refresh_token) {
        setAdminRefreshToken((res as any).refresh_token);
      }
      setAuthed(true);
      toast.success(t("admin.loginGranted"));
    } catch {
      toast.error(t("admin.invalidCreds"));
    }
  };

  useEffect(() => {
    const onExpired = () => {
      setAuthed(false);
      toast.error("Admin session expired. Please login again.");
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  if (!authed) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="glass rounded-2xl p-8">
            <div className="flex items-center gap-2 mb-6">
              <Shield size={20} className="text-accent" />
              <h1 className="text-lg font-bold text-surface-50">{t("admin.access")}</h1>
            </div>
            <form onSubmit={login} className="flex flex-col gap-3">
              <input
                className="input-field text-sm"
                placeholder={t("admin.username")}
                value={creds.username}
                onChange={(e) => setCreds({ ...creds, username: e.target.value })}
              />
              <input
                className="input-field text-sm"
                type="password"
                placeholder={t("admin.password")}
                value={creds.password}
                onChange={(e) => setCreds({ ...creds, password: e.target.value })}
                autoComplete="current-password"
                spellCheck={false}
              />
              <button type="submit" className="btn-primary flex items-center justify-center gap-2">
                <Shield size={14} /> {t("admin.login")}
              </button>
            </form>
            <p className="text-xs text-surface-200/30 mt-4 text-center">{t("admin.defaultCreds")}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-6">
      <div className="max-w-4xl mx-auto flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-surface-50 flex items-center gap-2">
              <Shield size={20} className="text-accent" /> {t("admin.dashboard")}
            </h1>
            <p className="text-sm text-surface-200/50 mt-1">{t("admin.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            {health?.status === "healthy"
              ? <CheckCircle size={16} className="text-success" />
              : <AlertCircle size={16} className="text-danger" />
            }
            <span className="text-sm text-surface-200/70">{health?.status ?? t("admin.checking")}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-b border-subtle pb-3">
          {([ ["overview", "概览"], ["accounts", "账号"], ["groups", "群组"], ["push", "推送"], ["audit", "审计日志"] ] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              className={clsx("rounded-lg px-3 py-2 text-sm", tab === key ? "bg-accent text-white" : "hover-surface text-surface-200/70")}>{label}</button>
          ))}
        </div>

        {tab === "overview" && <>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard icon={Activity} label={t("admin.system")} value={health?.status ?? "-"} color={health?.status === "healthy" ? "text-success" : "text-warn"} />
          <StatCard icon={Server} label={t("admin.version")} value={status?.version ?? "-"} />
          <StatCard icon={Users} label={t("admin.accounts")} value={status?.stats?.accounts ?? "-"} />
          <StatCard icon={Database} label={t("admin.storage")} value={status?.stats?.attachments ?? "-"} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard icon={Users} label="启用账号" value={userStats?.enabled ?? "-"} />
          <StatCard icon={Database} label="附件数量" value={storageUsage?.file_count ?? "-"} />
          <StatCard icon={Database} label="附件容量（MB）" value={storageUsage?.total_mb ?? "-"} />
        </div>
        <section className="glass rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-3">最近 7 天消息量</h2>
          <div className="flex flex-wrap gap-3 text-sm text-surface-200/70">
            {(activity?.daily_messages ?? []).map((day: { date: string; count: number }) => (
              <span key={day.date}>{day.date}: {day.count}</span>
            ))}
            {!activity?.daily_messages?.length && <span>暂无记录</span>}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-surface-200 uppercase tracking-wide mb-3">{t("admin.services")}</h2>
          <div className="flex flex-col gap-2">
            {(health?.services ?? []).map((svc: any) => (
              <div key={svc.name} className="glass rounded-xl px-4 py-3 flex items-center gap-4">
                <div className={clsx("w-2 h-2 rounded-full", svc.ok ? "bg-success animate-pulse-soft" : "bg-danger")} />
                <div className="flex-1">
                  <span className="text-sm text-surface-50">{svc.label}</span>
                  <span className="text-xs text-surface-200/40 ml-2">{svc.detail}</span>
                </div>
                <code className={clsx("text-xs font-mono", svc.ok ? "text-success" : "text-danger")}>
                  {svc.ok ? "up" : "down"}
                </code>
              </div>
            ))}
            {!health?.services?.length && (
              <div className="glass rounded-xl px-4 py-3 text-sm text-surface-200/40">{t("admin.noServiceHealth")}</div>
            )}
          </div>
        </section>
        </>}

        {tab === "accounts" && <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">账号管理</h2>
            <input className="input-field text-sm" placeholder="按 JID 搜索" value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} />
          </div>
          <p className="text-xs text-surface-200/50">停用会阻止该账号使用网站 API；Prosody 账号仍保留。</p>
          {accountsLoading && <p className="text-sm text-surface-200/50">加载中…</p>}
          {accountsError && <p className="text-sm text-danger">账号列表加载失败，请稍后重试。</p>}
          {(accounts as { id: string; jid: string; display_name?: string; is_enabled: boolean; created_at?: string }[]).map((account) => (
            <div key={account.id} className="glass rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0"><p className="text-sm font-medium break-all">{account.jid}</p>
                <p className="text-xs text-surface-200/50">{account.display_name || "—"} · {account.is_enabled ? "已启用" : "已停用"} · {account.created_at?.slice(0, 10) || "—"}</p></div>
              <button type="button" disabled={accountBusy === account.id} onClick={() => void setAccountEnabled(account)}
                className={clsx("btn-ghost text-xs", account.is_enabled ? "text-danger" : "text-success")}>{account.is_enabled ? "停用" : "启用"}</button>
            </div>
          ))}
          {!accountsLoading && !accountsError && !accounts.length && <p className="text-sm text-surface-200/50">没有匹配的账号</p>}
        </section>}

        {tab === "groups" && <section className="space-y-3">
          <h2 className="text-sm font-semibold">群组记录</h2>
          <p className="text-xs text-surface-200/50">这里列出 Prosody 中的群组；关联账号数来自网站数据库。</p>
          {groupsLoading && <p className="text-sm text-surface-200/50">加载中…</p>}
          {groupsError && <p className="text-sm text-danger">无法从 Prosody 读取群组，请稍后重试。</p>}
          {(groups as { jid: string; account_count: number }[]).map((group) => (
            <div key={group.jid} className="glass rounded-xl p-4 flex items-center justify-between gap-3">
              <span className="text-sm break-all">{group.jid}</span><span className="text-xs text-surface-200/50 whitespace-nowrap">关联账号 {group.account_count}</span>
            </div>
          ))}
          {!groupsLoading && !groupsError && !groups.length && <p className="text-sm text-surface-200/50">暂无群组记录</p>}
        </section>}

        {tab === "push" && <section className="space-y-3">
          <h2 className="text-sm font-semibold">推送状态</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <StatCard icon={Users} label="浏览器推送订阅" value={pushStatus?.web_push_subscriptions ?? "-"} />
            <StatCard icon={Users} label="ntfy 订阅" value={pushStatus?.ntfy_subscriptions ?? "-"} />
            <StatCard icon={Server} label="浏览器推送配置" value={pushStatus ? (pushStatus.web_push_configured ? "已配置" : "未配置") : "-"} />
            <StatCard icon={Server} label="ntfy 配置" value={pushStatus ? (pushStatus.ntfy_configured ? "已配置" : "未配置") : "-"} />
          </div>
        </section>}

        {tab === "audit" && <section>
          <h2 className="text-sm font-semibold text-surface-200 uppercase tracking-wide mb-3">
            {t("admin.audit")}
          </h2>
          <div className="glass rounded-xl p-4">
            {!auditLogs?.length ? (
              <div className="text-center text-sm text-surface-200/30">
                <FileText size={24} className="mx-auto mb-2 opacity-30" />
                {t("admin.noAudit")}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {auditLogs.map((log: any) => (
                  <div key={log.id} className="rounded-lg border-default px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-surface-50">{log.action}</span>
                      <span className="text-[11px] text-surface-200/40">{log.created_at ?? "-"}</span>
                    </div>
                    <div className="text-xs text-surface-200/50 mt-1">
                      actor: {log.actor ?? "-"} | target: {log.target_type ?? "-"}:{log.target_id ?? "-"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>}

        <button
          onClick={async () => {
            // Revoke server-side first so a stolen token can't be reused.
            // We pass the refresh token to invalidate it too. The bearer
            // access token is taken from the Authorization header by the
            // server (axios interceptor adds it from sessionStorage).
            const refreshTok = getAdminRefreshToken();
            try {
              await authApi.logout(refreshTok ?? undefined);
            } catch {
              // Already-expired tokens still get cleaned up locally below.
            }
            sessionStorage.removeItem("admin_token");
            clearAdminRefreshToken();
            setAuthed(false);
          }}
          className="btn-ghost text-xs text-danger self-start flex items-center gap-1.5"
        >
          <Shield size={12} /> {t("admin.logout")}
        </button>
      </div>
    </div>
  );
}

