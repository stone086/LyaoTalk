// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useAccountStore } from "./accountStore";

afterEach(() => {
  localStorage.removeItem("liaot-accounts");
  useAccountStore.setState({ accounts: [], activeAccountId: null });
});

describe("account connection state", () => {
  it("does not show a persisted online state before reconnecting", async () => {
    localStorage.setItem("liaot-accounts", JSON.stringify({
      state: {
        accounts: [{ id: "alice", jid: "alice@example.com", domain: "example.com", presence: "available", connected: true }],
        activeAccountId: "alice",
      },
      version: 0,
    }));
    await useAccountStore.persist.rehydrate();
    expect(useAccountStore.getState().accounts[0].connected).toBe(false);
  });
});
