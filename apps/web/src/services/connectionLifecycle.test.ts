// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { XmppClient } from "./xmppAdapter";
import { getSupervisorState, superviseConnection, unsuperviseConnection } from "./connectionSupervisor";

function fakeClient(accountId: string) {
  let listener: ((data: { status: string }) => void) | undefined;
  return {
    config: { accountId },
    connected: false,
    on: vi.fn((_event: string, callback: (data: { status: string }) => void) => {
      listener = callback;
      return () => { listener = undefined; };
    }),
    emit(status: string) { listener?.({ status }); },
  };
}

afterEach(() => {
  unsuperviseConnection("retry-test");
  unsuperviseConnection("online-test");
  unsuperviseConnection("replacement-test");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("XMPP connection lifecycle", () => {
  it("retries when supervision is replaced after a disconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const client = fakeClient("replacement-test");
    client.connected = true;
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const options = { reconnect, initialBackoffMs: 1, maxBackoffMs: 1, jitterFraction: 0 };
    superviseConnection(client as unknown as XmppClient, options);
    client.connected = false;
    client.emit("disconnected");
    // Mirrors the account-store rerender, which tears down the old timer.
    superviseConnection(client as unknown as XmppClient, options);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("keeps retrying after the former 50-attempt cutoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const client = fakeClient("retry-test");
    const reconnect = vi.fn().mockRejectedValue(new Error("offline"));
    superviseConnection(client as unknown as XmppClient, {
      reconnect, initialBackoffMs: 1, maxBackoffMs: 1, jitterFraction: 0,
    });
    client.emit("disconnected");
    await vi.advanceTimersByTimeAsync(55);
    expect(reconnect.mock.calls.length).toBeGreaterThan(50);
    expect(getSupervisorState("retry-test")?.active).toBe(true);
  });

  it("does not replace a healthy connection when the browser reports online", () => {
    const client = fakeClient("online-test");
    client.connected = true;
    const reconnect = vi.fn();
    superviseConnection(client as unknown as XmppClient, { reconnect });
    window.dispatchEvent(new Event("online"));
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("preserves the stream resume state only for a failed transport", () => {
    const client = new XmppClient({ jid: "a@example.test", password: "x", wsUrl: "wss://example.test/xmpp-websocket", accountId: "a" });
    const disconnect = vi.fn();
    (client as any)._connection = { disconnect };
    client.disconnect(true);
    expect(disconnect).not.toHaveBeenCalled();
    (client as any)._connection = { disconnect };
    client.disconnect();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("closes a still-open socket before replacing a client", () => {
    const client = new XmppClient({ jid: "a@example.test", password: "x", wsUrl: "wss://example.test/xmpp-websocket", accountId: "a" });
    const disconnect = vi.fn();
    (client as any)._connection = { disconnect, _proto: { socket: { readyState: 1 } } };
    client.disconnect(true);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
