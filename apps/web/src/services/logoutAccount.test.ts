// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccountStore } from "@/stores/accountStore";
import { authApi, getUserToken, setUserRefreshToken, setUserToken } from "./api";
import { logoutAccount } from "./logoutAccount";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null });
});

describe("account logout", () => {
  it("revokes only the selected account and keeps another account signed in", async () => {
    useAccountStore.setState({
      activeAccountId: "bob",
      accounts: [
        { id: "alice", jid: "alice@example.test", domain: "example.test", presence: "available", connected: true },
        { id: "bob", jid: "bob@example.test", domain: "example.test", presence: "available", connected: true },
      ],
    });
    setUserToken("alice", "alice-access");
    setUserRefreshToken("alice", "alice-refresh");
    setUserToken("bob", "bob-access");
    setUserRefreshToken("bob", "bob-refresh");
    const revoke = vi.spyOn(authApi, "logout").mockResolvedValue({ revoked: ["access", "refresh"] });

    const result = await logoutAccount("bob");

    expect(result.remoteRevoked).toBe(true);
    expect(revoke).toHaveBeenCalledWith("bob-refresh", "bob");
    expect(getUserToken("bob")).toBeNull();
    expect(getUserToken("alice")).toBe("alice-access");
    expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual(["alice"]);
    expect(useAccountStore.getState().activeAccountId).toBe("alice");
  });
});
