// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const connected = vi.fn();
  const reconnecting = vi.fn();
  const connect = vi.fn().mockResolvedValue(undefined);
  const client = { connect, config: { accountId: "restored" } };
  return { connected, reconnecting, connect, client,
    createClient: vi.fn(() => client), supervise: vi.fn(), getToken: vi.fn().mockResolvedValue(null) };
});

vi.mock("@/stores/accountStore", () => {
  const state = {
    accounts: [
      { id: "restored", jid: "a@example.test", is_enabled: true, manuallyOffline: false },
      { id: "needs-login", jid: "b@example.test", is_enabled: true, manuallyOffline: false },
    ],
    setConnected: mocks.connected,
  };
  return {
    useAccountStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }),
    getAccountPassword: (id: string) => id === "restored" ? "runtime-password" : null,
  };
});
vi.mock("@/stores/reconnectStore", () => ({ useReconnectStore: (selector: (s: { setReconnecting: typeof mocks.reconnecting }) => unknown) => selector({ setReconnecting: mocks.reconnecting }) }));
vi.mock("@/services/xmppAdapter", () => ({ createClient: mocks.createClient, getClient: () => null, destroyClient: vi.fn() }));
vi.mock("@/services/xmppBridge", () => ({ initXmppBridge: vi.fn() }));
vi.mock("@/services/connectionSupervisor", () => ({ superviseConnection: mocks.supervise, unsuperviseConnection: vi.fn(), getSupervisorState: () => null }));
vi.mock("@/services/api", () => ({ authApi: { getUserToken: mocks.getToken }, setUserToken: vi.fn(), setUserRefreshToken: vi.fn() }));

import { useXmppReconnect } from "./useXmppReconnect";
import { useAccountStore } from "@/stores/accountStore";

function Harness() { useXmppReconnect(); return null; }

afterEach(() => { vi.clearAllMocks(); });

describe("restored browser session", () => {
  it("reconnects an account with session credentials and leaves other accounts alone", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({ accountId: "restored", password: "runtime-password" }));
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.connected).toHaveBeenCalledWith("restored", true);
    expect(mocks.connected).not.toHaveBeenCalledWith("needs-login", true);
    await act(async () => root.unmount());
    element.remove();
  });

  it("does not reconnect an account the user set offline", async () => {
    const account = useAccountStore.getState().accounts[0];
    account.manuallyOffline = true;
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    account.manuallyOffline = false;
    element.remove();
  });
});
