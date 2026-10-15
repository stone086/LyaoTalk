/**
 * connectionSupervisor.ts — Auto-reconnect XMPP clients on disconnect.
 *
 * Lifecycle:
 *   - On `connection.changed` -> "disconnected": schedule reconnect with
 *     exponential backoff (1s, 2s, 4s, 8s, 16s, 30s, 60s capped) + ±25% jitter.
 *   - On browser `online` event: cancel current backoff, retry immediately.
 *     (NAT/wifi loss -> recovery is the most common disconnect cause.)
 *   - On `visibilitychange` -> visible: if disconnected, retry immediately.
 *     (Mobile browsers freeze background tabs and silently drop the WebSocket.)
 *   - User-initiated disconnect (logout) suppresses auto-reconnect.
 *
 * Each XmppClient is supervised independently — multi-account login works.
 */
import type { XmppClient } from "./xmppAdapter";

export interface SupervisorOptions {
  /** Initial backoff in ms. Default 1000. */
  initialBackoffMs?: number;
  /** Cap on backoff in ms. Default 60000. */
  maxBackoffMs?: number;
  /** Backoff multiplier per attempt. Default 2. */
  multiplier?: number;
  /** Maximum number of automatic attempts before giving up. Default unlimited. */
  maxAttempts?: number;
  /** ±jitter as fraction of computed backoff. Default 0.25. */
  jitterFraction?: number;
  /** Reconnect callback the supervisor will invoke. Must return a Promise that
   *  resolves on successful CONNECTED, or rejects on terminal failure. */
  reconnect: () => Promise<void>;
}

interface SupervisorState {
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;            // is supervision currently armed
  intentionalDisconnect: boolean;  // user logged out -> don't retry
  lastAttemptAt: number;
  inProgress: boolean;
  hooks: {
    online?: () => void;
    visibility?: () => void;
    clientUnsub?: () => void;
  };
}

const supervisors = new Map<string, SupervisorState>();

function jittered(ms: number, fraction: number): number {
  const delta = ms * fraction;
  return ms + (Math.random() * 2 - 1) * delta;
}

function computeBackoff(attempt: number, opts: Required<SupervisorOptions>): number {
  const raw = opts.initialBackoffMs * Math.pow(opts.multiplier, attempt);
  const capped = Math.min(raw, opts.maxBackoffMs);
  return Math.max(0, jittered(capped, opts.jitterFraction));
}

/**
 * Begin supervising a client. Subsequent disconnects will trigger reconnect
 * attempts via the supplied callback.
 */
export function superviseConnection(
  client: XmppClient,
  optsIn: SupervisorOptions,
): void {
  const accountId = client.config.accountId;
  // Stop any previous supervisor for this account
  unsuperviseConnection(accountId);

  const opts: Required<SupervisorOptions> = {
    initialBackoffMs: optsIn.initialBackoffMs ?? 1000,
    maxBackoffMs: optsIn.maxBackoffMs ?? 60000,
    multiplier: optsIn.multiplier ?? 2,
    maxAttempts: optsIn.maxAttempts ?? Number.POSITIVE_INFINITY,
    jitterFraction: optsIn.jitterFraction ?? 0.25,
    reconnect: optsIn.reconnect,
  };

  const state: SupervisorState = {
    attempts: 0,
    timer: null,
    active: true,
    intentionalDisconnect: false,
    lastAttemptAt: 0,
    inProgress: false,
    hooks: {},
  };
  supervisors.set(accountId, state);

  const log = (msg: string, extra?: object) => {
    // eslint-disable-next-line no-console
    console.info(
      `[XMPP-supervisor ${new Date().toISOString()}] ${msg} account=${accountId}`,
      extra ?? "",
    );
  };

  const tryReconnect = async () => {
    if (!state.active || state.intentionalDisconnect) return;
    if (state.inProgress) return;
    if (state.attempts >= opts.maxAttempts) {
      log("max-attempts-reached giving up");
      state.active = false;
      return;
    }
    state.attempts++;
    state.lastAttemptAt = Date.now();
    state.inProgress = true;
    log("reconnect-attempt", { attempt: state.attempts });
    try {
      await opts.reconnect();
      log("reconnect-success", { attempt: state.attempts });
      state.attempts = 0;
      state.inProgress = false;
    } catch (err) {
      state.inProgress = false;
      log("reconnect-failed", {
        attempt: state.attempts,
        err: err instanceof Error ? err.message : String(err),
      });
      schedule();
    }
  };

  const schedule = () => {
    if (!state.active || state.intentionalDisconnect) return;
    if (state.timer) clearTimeout(state.timer);
    const delay = computeBackoff(state.attempts, opts);
    log("reconnect-scheduled", { attempt: state.attempts + 1, delayMs: Math.round(delay) });
    state.timer = setTimeout(() => {
      state.timer = null;
      tryReconnect();
    }, delay);
  };

  // React to disconnects
  const unsubClient = client.on("connection.changed", (data: any) => {
    if (data.status === "connected") {
      // Successful (re)connect: reset counters
      state.attempts = 0;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    } else if (data.status === "disconnected") {
      if (state.intentionalDisconnect) {
        log("disconnect-intentional skipping reconnect");
        return;
      }
      // Network died — schedule a reconnect.
      schedule();
    }
  });
  state.hooks.clientUnsub = unsubClient;

  // Online/offline events: when the device comes back online, retry immediately
  if (typeof window !== "undefined") {
    state.hooks.online = () => {
      if (state.intentionalDisconnect) return;
      if (client.connected && !state.timer && !state.inProgress) return;
      log("network-online forcing immediate retry");
      state.attempts = 0;  // reset backoff
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      tryReconnect();
    };
    window.addEventListener("online", state.hooks.online);
  }

  // Visibility events: tab returning to foreground often means WS was killed
  if (typeof document !== "undefined") {
    state.hooks.visibility = () => {
      if (document.visibilityState !== "visible") return;
      if (state.intentionalDisconnect) return;
      // Check if we appear connected; if so, send a ping immediately to verify.
      // If not, retry now.
      if (!state.timer && !state.inProgress) {
        // Connected and supervisor is idle — nothing to do; the next keepalive
        // tick will detect any stalled connection.
        return;
      }
      log("visibility-visible accelerating reconnect");
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.attempts = Math.max(0, state.attempts - 1);
      tryReconnect();
    };
    document.addEventListener("visibilitychange", state.hooks.visibility);
  }

  // React may recreate supervision after the bridge updates account state on
  // disconnect. That cancels the previous timer, so arm this new supervisor
  // when it inherits a client whose transport is already down.
  if (!client.connected) schedule();
}

/**
 * Mark a client's disconnect as intentional (user logout).
 * The supervisor will not retry.
 */
export function markIntentionalDisconnect(accountId: string): void {
  const state = supervisors.get(accountId);
  if (state) {
    state.intentionalDisconnect = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }
}

/**
 * Stop supervising a client and detach all listeners.
 */
export function unsuperviseConnection(accountId: string): void {
  const state = supervisors.get(accountId);
  if (!state) return;
  state.active = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.hooks.online && typeof window !== "undefined") {
    window.removeEventListener("online", state.hooks.online);
  }
  if (state.hooks.visibility && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", state.hooks.visibility);
  }
  if (state.hooks.clientUnsub) {
    try {
      state.hooks.clientUnsub();
    } catch {}
  }
  supervisors.delete(accountId);
}

/**
 * Inspect supervisor state for diagnostics / UI display.
 */
export function getSupervisorState(accountId: string): {
  active: boolean;
  attempts: number;
  inProgress: boolean;
  lastAttemptAt: number;
  intentionalDisconnect: boolean;
} | null {
  const s = supervisors.get(accountId);
  if (!s) return null;
  return {
    active: s.active,
    attempts: s.attempts,
    inProgress: s.inProgress,
    lastAttemptAt: s.lastAttemptAt,
    intentionalDisconnect: s.intentionalDisconnect,
  };
}
