import { useEffect, useRef } from "react";
import { getAccountPassword, useAccountStore } from "@/stores/accountStore";
import { createClient, getClient, destroyClient } from "@/services/xmppAdapter";
import { initXmppBridge } from "@/services/xmppBridge";
import { useReconnectStore } from "@/stores/reconnectStore";
import { authApi, setUserToken, setUserRefreshToken } from "@/services/api";
import { isLocalXmppAccount, requireLocalXmppAccount } from "@/services/localXmppAccount";
import {
  superviseConnection,
  unsuperviseConnection,
  getSupervisorState,
} from "@/services/connectionSupervisor";

/**
 * Watches all accounts and supervises auto-reconnect.
 * Mount once at the app root level.
 *
 * Strategy:
 *   - For every enabled account, attach a connectionSupervisor.
 *   - Supervisor uses exponential backoff with jitter (1s..60s, ±25%).
 *   - On `online` / `visibilitychange` events the supervisor accelerates retries
 *     so the user is back online within seconds of network/tab recovery.
 *   - Account list changes (add/remove account) attach/detach supervisors.
 */
export function useXmppReconnect() {
  const accounts = useAccountStore((s) => s.accounts);
  const setConnected = useAccountStore((s) => s.setConnected);
  const setReconnecting = useReconnectStore((s) => s.setReconnecting);
  const startupAttempts = useRef(new Map<string, { timer?: ReturnType<typeof setTimeout>; attempts: number }>());
  const inFlightConnections = useRef(new Map<string, Promise<void>>());
  // Presence and connection status update the account objects frequently.
  // Replacing supervision for those cosmetic changes cancels backoff timers.
  const accountSignature = accounts.map((a) => `${a.id}:${a.jid}:${a.is_enabled !== false}:${Boolean(a.manuallyOffline)}`).join("|");
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  useEffect(() => () => {
    startupAttempts.current.forEach(({ timer }) => { if (timer) clearTimeout(timer); });
    startupAttempts.current.clear();
  }, []);

  useEffect(() => {
    const accounts = accountsRef.current;
    const supervisedIds = new Set<string>();

    const deriveWsUrl = (): string => {
      // Same-origin construction matches LoginPage.tsx logic so we don't
      // accidentally reconnect to ws://localhost:5280 from a wss://prod page.
      const sameOrigin = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/xmpp-websocket`;
      const configured = (import.meta.env.VITE_XMPP_WS_URL as string | undefined) ?? "";
      if (configured) {
        try {
          const u = new URL(configured);
          if (u.host === window.location.host) return configured;
        } catch {}
      }
      return sameOrigin;
    };

    const connectOnce = async (accountId: string): Promise<void> => {
      const account = accounts.find((a) => a.id === accountId);
      if (!account) throw new Error("Account vanished from store");
      requireLocalXmppAccount(account.jid);
      if (useAccountStore.getState().accounts.find((item) => item.id === accountId)?.manuallyOffline) {
        throw new Error("Account is manually offline");
      }
      const password = getAccountPassword(accountId);
      if (!password) {
        // No runtime password — can't reconnect silently. The user must log in.
        setConnected(accountId, false);
        setReconnecting(accountId, false);
        unsuperviseConnection(accountId);
        throw new Error("No runtime password — manual login required");
      }

      // Tear down any zombie client to avoid two parallel sockets
      const existing = getClient(accountId);
      if (existing?.connected) {
        setConnected(accountId, true);
        setReconnecting(accountId, false);
        return;
      }
      if (existing) {
        // An ungracefully closed socket still has resumable XEP-0198 state in
        // sessionStorage. Do not send Strophe's graceful disconnect here.
        destroyClient(accountId, true);
      }

      const newClient = createClient({
        jid: account.jid,
        password,
        wsUrl: deriveWsUrl(),
        accountId,
        // Stability tunings — see XmppClientConfig
        keepaliveIntervalMs: 45_000,
        keepaliveTimeoutMs: 20_000,
        smRequestIntervalMs: 30_000,
      });
      initXmppBridge(newClient);

      setReconnecting(accountId, true);
      try {
        await newClient.connect();
        if (useAccountStore.getState().accounts.find((item) => item.id === accountId)?.manuallyOffline) {
          destroyClient(accountId);
          setConnected(accountId, false);
          throw new Error("Account went offline while connecting");
        }
        // Keep the old supervisor armed until connect succeeds. Otherwise a
        // failed new connection has no supervisor to schedule the next retry.
        attachSupervisor(accountId);
        setConnected(accountId, true);
        setReconnecting(accountId, false);
        // Refresh user-token after reconnect so file uploads keep working
        try {
          const tokenRes = await authApi.getUserToken(account.jid, password).catch(() => null);
          if (tokenRes?.access_token) {
            setUserToken(accountId, tokenRes.access_token);
            if ((tokenRes as any).refresh_token) {
              setUserRefreshToken(accountId, (tokenRes as any).refresh_token);
            }
          }
        } catch {
          // Non-fatal — upload will retry token next time
        }
      } catch (err) {
        setConnected(accountId, false);
        // setReconnecting stays true while supervisor keeps trying
        throw err;
      }
    };

    const attemptConnect = (accountId: string): Promise<void> => {
      const running = inFlightConnections.current.get(accountId);
      if (running) return running;
      const promise = Promise.resolve().then(() => connectOnce(accountId));
      inFlightConnections.current.set(accountId, promise);
      void promise.finally(() => {
        if (inFlightConnections.current.get(accountId) === promise) {
          inFlightConnections.current.delete(accountId);
        }
      }).catch(() => {});
      return promise;
    };

    const attachSupervisor = (accountId: string) => {
      const client = getClient(accountId);
      if (!client) return;
      superviseConnection(client, {
        initialBackoffMs: 1000,
        maxBackoffMs: 60_000,
        multiplier: 2,
        jitterFraction: 0.25,
        reconnect: () => attemptConnect(accountId),
      });
      supervisedIds.add(accountId);
    };

    // A reload destroys all in-memory clients but keeps account credentials in
    // sessionStorage. Start those accounts again before a supervisor exists.
    // A new browser session has no password and correctly requires login.
    const startRestoredAccount = (accountId: string) => {
      if (startupAttempts.current.has(accountId)) return;
      const progress = { attempts: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      startupAttempts.current.set(accountId, progress);
      const retry = async () => {
        const current = useAccountStore.getState().accounts.find((a) => a.id === accountId);
        if (!current?.is_enabled || current.manuallyOffline || !getAccountPassword(accountId)) {
          startupAttempts.current.delete(accountId);
          return;
        }
        try {
          await attemptConnect(accountId);
          startupAttempts.current.delete(accountId);
        } catch {
          if (startupAttempts.current.get(accountId) !== progress) return;
          progress.attempts += 1;
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(progress.attempts - 1, 6));
          progress.timer = setTimeout(retry, delay);
        }
      };
      void retry();
    };

    // Phase 1: supervise live clients and restore accounts after a reload.
    accounts.forEach((account) => {
      if (!account.is_enabled || account.manuallyOffline) return;
      if (!isLocalXmppAccount(account.jid)) {
        setConnected(account.id, false);
        return;
      }
      const client = getClient(account.id);
      if (client && !startupAttempts.current.has(account.id)) {
        attachSupervisor(account.id);
      } else if (getAccountPassword(account.id)) {
        startRestoredAccount(account.id);
      }
    });

    const onManualReconnect = (event: Event) => {
      const accountId = (event as CustomEvent<string>).detail;
      const account = useAccountStore.getState().accounts.find((item) => item.id === accountId);
      if (!account?.is_enabled || account.manuallyOffline) return;
      void attemptConnect(accountId).catch(() => {});
    };
    window.addEventListener("lyaotalk:reconnect-account", onManualReconnect);

    // Phase 2: poll supervisor state every 5s -> drive setReconnecting
    // (purely cosmetic so the UI shows "Reconnecting..." correctly)
    const stateTimer = setInterval(() => {
      accounts.forEach((account) => {
        const s = getSupervisorState(account.id);
        if (!s) return;
        if (s.inProgress || (s.active && s.attempts > 0 && !s.intentionalDisconnect)) {
          setReconnecting(account.id, true);
        }
      });
    }, 5000);

    return () => {
      clearInterval(stateTimer);
      window.removeEventListener("lyaotalk:reconnect-account", onManualReconnect);
      supervisedIds.forEach((id) => unsuperviseConnection(id));
    };
  }, [accountSignature, setConnected, setReconnecting]);
}
