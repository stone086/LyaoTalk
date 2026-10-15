/**
 * apiSocket.ts
 * Connects to the FastAPI WebSocket endpoint for real-time server push.
 * Separate from XMPP — this handles backend-originated events
 * (AI job completions, admin alerts, plugin events, etc.).
 *
 * Authentication: passes the user JWT as ?token= query param
 * because WebSocket connections cannot carry Authorization headers.
 */

import { getUserToken } from "@/services/api";

type ApiSocketEvent =
  | "connected"
  | "disconnected"
  | "ai.job.completed"
  | "plugin.event"
  | "admin.alert"
  | "ping"
  | "pong";

type Handler = (data: unknown) => void;

class ApiSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<ApiSocketEvent, Handler[]> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private accountId: string | null = null;
  private _connected = false;

  get connected() {
    return this._connected;
  }

  connect(accountId: string) {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.accountId = accountId;

    const token = getUserToken(accountId) ?? sessionStorage.getItem("admin_token") ?? "";
    const wsBase = (import.meta.env.VITE_API_URL ?? "http://localhost:8000")
      .replace(/^https/, "wss")
      .replace(/^http/, "ws");
    const url = `${wsBase}/ws/${accountId}?token=${encodeURIComponent(token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._connected = true;
      this.emit("connected", { accountId });
      this._startPing();
    };

    this.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data?.type === "ping" && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "pong" }));
        }
        this.emit(data.type as ApiSocketEvent, data);
      } catch { /* ignore malformed messages */ }
    };

    this.ws.onclose = (ev) => {
      this._connected = false;
      this._stopPing();
      this.emit("disconnected", { accountId, code: ev.code });
      // 4001/4003 = auth failure, do not reconnect
      if (ev.code !== 4001 && ev.code !== 4003) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect() {
    this._stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.accountId = null;
    this._connected = false;
  }

  disconnectAccount(accountId: string) {
    if (this.accountId === accountId) this.disconnect();
  }

  on(event: ApiSocketEvent, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, [...list, handler]);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((h) => h !== handler)
      );
    };
  }

  private emit(event: ApiSocketEvent, data: unknown) {
    (this.handlers.get(event) ?? []).forEach((h) => h(data));
  }

  private _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25000);
  }

  private _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.accountId) this.connect(this.accountId);
    }, 5000);
  }
}

export const apiSocket = new ApiSocketClient();
