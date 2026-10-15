import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUntrustedPeerDevices, isPeerDeviceTrusted, setPeerDeviceTrust } from "./omemoTrust";

function installLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
    configurable: true,
  });
}

describe("omemoTrust", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  it("treats unknown peer devices as untrusted", () => {
    const untrusted = getUntrustedPeerDevices("account-a", "Peer@Example.com/phone", [
      { deviceId: 12, fingerprint: "AAAA BBBB" },
    ]);

    expect(untrusted).toEqual([{ deviceId: 12, fingerprint: "AAAA BBBB" }]);
  });

  it("trusts a verified bare JID device", () => {
    setPeerDeviceTrust("account-a", "Peer@Example.com/phone", 12, "AAAA BBBB", true);

    expect(isPeerDeviceTrusted("account-a", "peer@example.com", 12, "AAAA BBBB")).toBe(true);
    expect(getUntrustedPeerDevices("account-a", "peer@example.com", [
      { deviceId: 12, fingerprint: "AAAA BBBB" },
    ])).toEqual([]);
  });

  it("rejects a device when its fingerprint changes", () => {
    setPeerDeviceTrust("account-a", "peer@example.com", 12, "AAAA BBBB", true);

    expect(isPeerDeviceTrusted("account-a", "peer@example.com", 12, "CCCC DDDD")).toBe(false);
    expect(getUntrustedPeerDevices("account-a", "peer@example.com", [
      { deviceId: 12, fingerprint: "CCCC DDDD" },
    ])).toEqual([{ deviceId: 12, fingerprint: "CCCC DDDD" }]);
  });
});
