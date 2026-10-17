import axios from "axios";
import { getAccountPassword, useAccountStore } from "@/stores/accountStore";
import { trustedFileObjectKey } from "./trustedFilesUrl";
export const ADMIN_SESSION_EXPIRED_EVENT = "lyaotalk:admin-session-expired";
const USER_TOKEN_KEY_PREFIX = "liaot-user-token:";
const USER_REFRESH_KEY_PREFIX = "liaot-user-refresh:";
const ADMIN_REFRESH_KEY = "admin_refresh_token";

export function getUserToken(accountId?: string | null): string | null {
  if (!accountId) return null;
  return sessionStorage.getItem(`${USER_TOKEN_KEY_PREFIX}${accountId}`);
}

export function setUserToken(accountId: string, token: string) {
  sessionStorage.setItem(`${USER_TOKEN_KEY_PREFIX}${accountId}`, token);
}

export function clearUserToken(accountId: string) {
  sessionStorage.removeItem(`${USER_TOKEN_KEY_PREFIX}${accountId}`);
  sessionStorage.removeItem(`${USER_REFRESH_KEY_PREFIX}${accountId}`);
}

export function getUserRefreshToken(accountId?: string | null): string | null {
  if (!accountId) return null;
  return sessionStorage.getItem(`${USER_REFRESH_KEY_PREFIX}${accountId}`);
}

export function setUserRefreshToken(accountId: string, token: string) {
  sessionStorage.setItem(`${USER_REFRESH_KEY_PREFIX}${accountId}`, token);
}

export function getAdminRefreshToken(): string | null {
  return sessionStorage.getItem(ADMIN_REFRESH_KEY);
}

export function setAdminRefreshToken(token: string) {
  sessionStorage.setItem(ADMIN_REFRESH_KEY, token);
}

export function clearAdminRefreshToken() {
  sessionStorage.removeItem(ADMIN_REFRESH_KEY);
}

/** Download a private file through the same-origin API with an auth header. */
export async function privateFileBlob(rawUrl: string, accountId?: string | null, signal?: AbortSignal): Promise<Blob> {
  const objectKey = trustedFileObjectKey(rawUrl, window.location.origin);
  if (!objectKey || !accountId) throw new Error("Private file URL or account is unavailable");
  const response = await api.get(`/attachments/download/${objectKey}`, {
    responseType: "blob",
    headers: { "X-LyaoTalk-Account-Id": accountId },
    signal,
  });
  return response.data as Blob;
}

/** Proxy ciphertext from a known federation host through our same-origin API. */
export async function remoteEncryptedBlob(rawUrl: string, accountId?: string | null, signal?: AbortSignal): Promise<Blob> {
  if (!accountId) throw new Error("Account is unavailable");
  const response = await api.post("/attachments/remote-encrypted", { url: rawUrl }, {
    responseType: "blob",
    headers: { "X-LyaoTalk-Account-Id": accountId },
    signal,
  });
  return response.data as Blob;
}

function normalizeApiUrl(raw?: string): string {
  const fallback = "/api";
  if (!raw) return fallback;
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return fallback;

  // Absolute URL: ensure path ends with /api
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      const path = (u.pathname || "/").replace(/\/+$/, "");
      if (path === "" || path === "/") {
        u.pathname = "/api";
      } else if (!path.endsWith("/api")) {
        u.pathname = `${path}/api`;
      }
      return u.toString().replace(/\/+$/, "");
    } catch {
      return fallback;
    }
  }

  // Relative path: ensure /api suffix
  if (value.startsWith("/")) {
    if (value === "/api" || value.endsWith("/api")) return value;
    return `${value}/api`.replace(/\/{2,}/g, "/");
  }

  return fallback;
}

const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL as string | undefined);

export const api = axios.create({
  baseURL: API_URL,
});

api.interceptors.request.use((config) => {
  const store = useAccountStore.getState();
  const publicAuthRequest = /^\/auth\/(?:user-token|admin\/login|register|config)(?:$|[/?])/.test(config.url ?? "");

  let accountId =
    (config as typeof config & { __lyaotalkAccountId?: string | null }).__lyaotalkAccountId ??
    (typeof config.headers?.["X-LyaoTalk-Account-Id"] === "string"
      ? config.headers["X-LyaoTalk-Account-Id"]
      : undefined) ??
    store.activeAccountId;

  // 🔥 兜底：没有 activeAccountId 时用第一个账号
  if (!accountId && store.accounts?.length > 0) {
    accountId = store.accounts[0].id;
  }

  console.debug("[API] using accountId:", accountId);

  const token = publicAuthRequest ? null :
    getUserToken(accountId) ?? sessionStorage.getItem("admin_token");

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
    console.debug("[API] token attached ✔");
  } else {
    console.warn("[API] NO TOKEN ❌", accountId);
  }

  (config as typeof config & { __lyaotalkAccountId?: string | null }).__lyaotalkAccountId = publicAuthRequest ? null : accountId;

  if (config.headers && "X-LyaoTalk-Account-Id" in config.headers) {
    delete config.headers["X-LyaoTalk-Account-Id"];
  }

  // Keep JSON default for normal requests, but never force it for FormData uploads.
  const isFormData =
    typeof FormData !== "undefined" && config.data instanceof FormData;
  if (!isFormData) {
    const hasExplicitContentType =
      Boolean(config.headers?.["Content-Type"]) || Boolean((config.headers as any)?.["content-type"]);
    if (!hasExplicitContentType) {
      (config.headers as any)["Content-Type"] = "application/json";
    }
  }

  return config;
});

// In-flight refresh tracking — prevent the thundering-herd of N concurrent
// requests all triggering N concurrent refresh calls when a token expires.
// Map<accountId-or-"admin", Promise<string>> resolves to the new access token.
const inflightRefresh = new Map<string, Promise<string>>();
const inflightUserReauth = new Map<string, Promise<string>>();

async function reauthenticateUserToken(accountId: string): Promise<string> {
  const existing = inflightUserReauth.get(accountId);
  if (existing) return existing;
  const account = useAccountStore.getState().accounts.find((item) => item.id === accountId);
  const password = getAccountPassword(accountId);
  if (!account || !password) throw new Error("Account sign-in required");
  const promise = axios.post(`${API_URL}/auth/user-token`, { jid: account.jid, password })
    .then((response) => {
      const accessToken = response.data.access_token as string;
      if (!accessToken) throw new Error("Account token unavailable");
      setUserToken(accountId, accessToken);
      if (response.data.refresh_token) setUserRefreshToken(accountId, response.data.refresh_token);
      return accessToken;
    })
    .finally(() => { inflightUserReauth.delete(accountId); });
  inflightUserReauth.set(accountId, promise);
  return promise;
}

async function refreshUserToken(accountId: string): Promise<string> {
  const existing = inflightRefresh.get(accountId);
  if (existing) return existing;
  const refreshTok = getUserRefreshToken(accountId);
  if (!refreshTok) throw new Error("no-refresh-token");
  const promise = axios
    .post(`${API_URL}/auth/refresh`, { refresh_token: refreshTok })
    .then((r) => {
      const newAccess: string = r.data.access_token;
      const newRefresh: string = r.data.refresh_token;
      setUserToken(accountId, newAccess);
      // Server rotates refresh tokens — store the new one
      if (newRefresh) setUserRefreshToken(accountId, newRefresh);
      return newAccess;
    })
    .finally(() => {
      inflightRefresh.delete(accountId);
    });
  inflightRefresh.set(accountId, promise);
  return promise;
}

async function refreshAdminToken(): Promise<string> {
  const existing = inflightRefresh.get("admin");
  if (existing) return existing;
  const refreshTok = getAdminRefreshToken();
  if (!refreshTok) throw new Error("no-refresh-token");
  const promise = axios
    .post(`${API_URL}/auth/refresh`, { refresh_token: refreshTok })
    .then((r) => {
      const newAccess: string = r.data.access_token;
      const newRefresh: string = r.data.refresh_token;
      sessionStorage.setItem("admin_token", newAccess);
      if (newRefresh) setAdminRefreshToken(newRefresh);
      return newAccess;
    })
    .finally(() => {
      inflightRefresh.delete("admin");
    });
  inflightRefresh.set("admin", promise);
  return promise;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error?.response?.status;
    const config = error?.config;
    const publicAuthRequest = /^\/auth\/(?:user-token|admin\/login|register|config)(?:$|[/?])/.test(config?.url ?? "");

    // Avoid recursion: don't try to refresh when the failure IS the refresh call,
    // and don't retry the same request more than once.
    if (status !== 401 || !config || config.__isRetry || config.url?.includes("/auth/refresh") || publicAuthRequest) {
      // Final 401 that we can't recover from — surface session-expired UX
      if (status === 401 && !publicAuthRequest && config?.headers?.Authorization === `Bearer ${sessionStorage.getItem("admin_token")}` && sessionStorage.getItem("admin_token")) {
        sessionStorage.removeItem("admin_token");
        clearAdminRefreshToken();
        window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
      }
      return Promise.reject(error);
    }

    // Decide which refresh path to use based on which token was attached
    const accountId = (config as typeof config & { __lyaotalkAccountId?: string | null }).__lyaotalkAccountId ?? null;
    const attachedToken = typeof config.headers?.Authorization === "string" ? config.headers.Authorization.replace(/^Bearer\s+/i, "") : null;
    const currentUserToken = accountId ? getUserToken(accountId) : null;
    // Another request may already have refreshed this account's token while
    // this request was in flight. Retry once with the new token instead of
    // treating its delayed 401 as an unrecoverable authentication failure.
    if (accountId && attachedToken && currentUserToken && currentUserToken !== attachedToken) {
      config.__isRetry = true;
      config.headers.Authorization = `Bearer ${currentUserToken}`;
      return api.request(config);
    }
    const hadUserToken = currentUserToken && currentUserToken === attachedToken ? attachedToken : null;
    const adminToken = sessionStorage.getItem("admin_token");
    const hadAdminToken = adminToken && adminToken === attachedToken ? adminToken : null;

    let newToken: string | null = null;
    try {
      if (accountId && (hadUserToken || !currentUserToken)) {
        try {
          newToken = await refreshUserToken(accountId);
        } catch {
          // The XMPP socket can remain online after the API refresh token
          // expires. Recover with the password retained for this tab.
          newToken = await reauthenticateUserToken(accountId);
        }
      } else if (hadAdminToken) {
        newToken = await refreshAdminToken();
      } else {
        return Promise.reject(error);
      }
    } catch {
      // Refresh failed — drop tokens, signal session expired, give up
      if (hadAdminToken && !hadUserToken) {
        sessionStorage.removeItem("admin_token");
        clearAdminRefreshToken();
        window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
      } else if (accountId) {
        clearUserToken(accountId);
      }
      return Promise.reject(error);
    }

    // Retry the original request once with the fresh token
    config.__isRetry = true;
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${newToken}`;
    return api.request(config);
  }
);

// Accounts
export const accountsApi = {
  list: () => api.get("/accounts/").then((r) => r.data),
  create: (data: { jid: string; domain: string; display_name?: string }) =>
    api.post("/accounts/", data).then((r) => r.data),
  delete: (id: string) => api.delete(`/accounts/${id}`).then((r) => r.data),
  getPreferences: (accountId: string) =>
    api.get(`/accounts/${accountId}/preferences`).then((r) => r.data),
  updatePreferences: (
    accountId: string,
    data: {
      auto_login?: boolean;
      default_presence?: string;
      theme_override?: string | null;
      notifications_enabled?: boolean;
      config_json?: Record<string, any>;
    }
  ) => api.put(`/accounts/${accountId}/preferences`, data).then((r) => r.data),
};

// Messages
export const messagesApi = {
  search: (q: string, accountId: string) =>
    api.get("/messages/search", { params: { q, account_id: accountId } }).then((r) => r.data),
  getConversation: (id: string, limit = 50) =>
    api.get(`/messages/conversation/${id}`, { params: { limit } }).then((r) => r.data),
  index: (data: object) => api.post("/messages/", data).then((r) => r.data),
  clearHistory: (accountId: string) =>
    api.delete("/messages/history", {
      params: { account_id: accountId },
      headers: { "X-LyaoTalk-Account-Id": accountId },
    }).then((r) => r.data),
  clearConversation: (accountId: string, peerJid: string) =>
    api.delete("/messages/conversation-history", {
      params: { account_id: accountId, peer_jid: peerJid },
      headers: { "X-LyaoTalk-Account-Id": accountId },
    }).then((r) => r.data),
};

// Attachments
export const attachmentsApi = {
    publishEncrypted: (attachmentId: string, accountId: string) =>
      api.post(`/attachments/${encodeURIComponent(attachmentId)}/publish-encrypted`, null,
        { headers: { "X-LyaoTalk-Account-Id": accountId } }).then((r) => r.data as { url: string }),
  share: (attachmentId: string, recipientJid: string, accountId: string) =>
    api.post(`/attachments/${encodeURIComponent(attachmentId)}/share`,
      { recipient_jid: recipientJid },
      { headers: { "X-LyaoTalk-Account-Id": accountId } }).then((r) => r.data),
  upload: async (file: File, messageId?: string, accountId?: string) => {
    const selectedAccountId = accountId ?? useAccountStore.getState().activeAccountId;
    if (!selectedAccountId) throw new Error("Account sign-in required");
    const send = async (token: string | null) => {
      const form = new FormData();
      form.append("file", file, file.name);
      if (messageId) form.append("message_id", messageId);
      // fetch owns the multipart boundary. Axios defaults/interceptors can
      // accidentally retain JSON or an incomplete multipart Content-Type.
      return fetch(`${API_URL}/attachments/upload`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
        credentials: "same-origin",
      });
    };
    let response = await send(getUserToken(selectedAccountId));
    if (response.status === 401) {
      let token: string;
      try {
        token = await refreshUserToken(selectedAccountId);
      } catch {
        token = await reauthenticateUserToken(selectedAccountId);
      }
      response = await send(token);
    }
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `Upload failed (${response.status})`);
    return data;
  },
};

// Plugins
export const pluginsApi = {
  list: () =>
    api.get("/plugins/").then((r) => {
      const data = r.data;
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.items)) return data.items;
      if (Array.isArray(data?.data)) return data.data;
      return [];
    }),
  enable: (id: string) => api.post(`/plugins/${id}/enable`).then((r) => r.data),
  disable: (id: string) => api.post(`/plugins/${id}/disable`).then((r) => r.data),
};

// AI
export const aiApi = {
  summarize: (messages: string[], conversationId?: string) =>
    api.post("/ai/summarize", { messages, conversation_id: conversationId }).then((r) => r.data),
  smartReply: (message: string) =>
    api.post("/ai/smart-reply", null, { params: { message } }).then((r) => r.data),
  translate: (text: string, targetLang = "en") =>
    api.post("/ai/translate", null, { params: { text, target_lang: targetLang } }).then((r) => r.data),
};

// Admin
export const adminApi = {
  status: () => api.get("/admin/status").then((r) => r.data),
  serviceHealth: () => api.get("/admin/service-health").then((r) => r.data),
  auditLogs: (limit = 20, offset = 0) =>
    api.get("/admin/audit-logs", { params: { limit, offset } }).then((r) => r.data),
  login: (username: string, password: string) =>
    api.post("/auth/admin/login", { username, password }).then((r) => r.data),
};

// Auth
export const authApi = {
  config: () =>
    api.get("/auth/config").then((r) => r.data as {
      xmpp_domain: string;
      public_domain: string;
      registration_enabled: boolean;
    }),
  register: (data: { jid: string; password: string }) =>
    api.post("/auth/register", data).then((r) => r.data),
  getUserToken: (jid: string, password: string) =>
    api.post("/auth/user-token", { jid, password }).then((r) => r.data as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      account_id: string;
      jid: string;
    }),
  refresh: (refresh_token: string) =>
    api.post("/auth/refresh", { refresh_token }).then((r) => r.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }),
  logout: (refresh_token?: string, accountId?: string) =>
    api.post("/auth/logout", refresh_token ? { refresh_token } : {},
      accountId ? { headers: { "X-LyaoTalk-Account-Id": accountId } } : undefined).then((r) => r.data),
};
