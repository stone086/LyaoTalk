// @vitest-environment jsdom
import axios, { AxiosError, type AxiosAdapter, type AxiosResponse } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, getUserRefreshToken, getUserToken, setUserRefreshToken, setUserToken } from "./api";
import { useAccountStore } from "@/stores/accountStore";
import { setAccountPassword } from "@/stores/accountStore";

function setupAccounts() {
  sessionStorage.clear();
  useAccountStore.setState({
    activeAccountId: "alice",
    accounts: [
      { id: "alice", jid: "alice@example.com", domain: "example.com", presence: "available", connected: true },
      { id: "bob", jid: "bob@example.com", domain: "example.com", presence: "available", connected: true },
    ],
  });
  setUserToken("alice", "alice-access");
  setUserRefreshToken("alice", "alice-refresh");
  setUserToken("bob", "bob-access");
  setUserRefreshToken("bob", "bob-refresh");
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("API account session isolation", () => {
  it("does not attach or revoke another account token on login 401", async () => {
    setupAccounts();
    sessionStorage.setItem("admin_token", "admin-access");
    const adapter: AxiosAdapter = async (config) => {
      expect(config.headers.Authorization).toBeUndefined();
      const response = { data: {}, status: 401, statusText: "Unauthorized", headers: {}, config } as AxiosResponse;
      throw new AxiosError("wrong password", "ERR_BAD_REQUEST", config, undefined, response);
    };
    await expect(api.post("/auth/user-token", {}, { adapter })).rejects.toBeInstanceOf(AxiosError);
    expect(getUserToken("alice")).toBe("alice-access");
    expect(getUserToken("bob")).toBe("bob-access");
    expect(sessionStorage.getItem("admin_token")).toBe("admin-access");
  });

  it("refreshes the request's account even when another account is active", async () => {
    setupAccounts();
    const refresh = vi.spyOn(axios, "post").mockResolvedValue({
      data: { access_token: "bob-new", refresh_token: "bob-refresh-new" },
    });
    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      const token = String(config.headers.Authorization);
      seen.push(token);
      if (token === "Bearer bob-access") {
        const response = { data: {}, status: 401, statusText: "Unauthorized", headers: {}, config } as AxiosResponse;
        throw new AxiosError("expired", "ERR_BAD_REQUEST", config, undefined, response);
      }
      return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
    };
    const result = await api.get("/accounts/bob/preferences", {
      headers: { "X-LiaoT-Account-Id": "bob" }, adapter,
    });
    expect(result.data.ok).toBe(true);
    expect(seen).toEqual(["Bearer bob-access", "Bearer bob-new"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getUserToken("alice")).toBe("alice-access");
    expect(getUserRefreshToken("alice")).toBe("alice-refresh");
    expect(getUserToken("bob")).toBe("bob-new");
  });

  it("retries a delayed 401 with a token refreshed by another request", async () => {
    setupAccounts();
    let releaseDelayed401!: () => void;
    const delayed401 = new Promise<void>((resolve) => { releaseDelayed401 = resolve; });
    const refresh = vi.spyOn(axios, "post").mockResolvedValue({
      data: { access_token: "alice-new", refresh_token: "alice-refresh-new" },
    });
    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      const token = String(config.headers.Authorization);
      seen.push(token);
      if (token === "Bearer alice-access") {
        if (config.url === "/attachments/remote-encrypted") await delayed401;
        const response = { data: {}, status: 401, statusText: "Unauthorized", headers: {}, config } as AxiosResponse;
        throw new AxiosError("expired", "ERR_BAD_REQUEST", config, undefined, response);
      }
      return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
    };
    const delayedImage = api.post("/attachments/remote-encrypted", {}, { adapter });
    await api.get("/accounts/alice/preferences", { adapter });
    releaseDelayed401();
    expect((await delayedImage).data.ok).toBe(true);
    expect(seen).toEqual(["Bearer alice-access", "Bearer alice-access", "Bearer alice-new", "Bearer alice-new"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reauthenticates the request account when its refresh token is invalid", async () => {
    setupAccounts();
    setAccountPassword("bob", "bob-password");
    const tokenRequest = vi.spyOn(axios, "post").mockImplementation(async (url) => {
      if (String(url).endsWith("/auth/refresh")) throw new Error("expired refresh token");
      expect(String(url)).toContain("/auth/user-token");
      return { data: { access_token: "bob-recovered", refresh_token: "bob-recovered-refresh" } };
    });
    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(String(config.headers.Authorization));
      if (config.headers.Authorization !== "Bearer bob-recovered") {
        const response = { data: {}, status: 401, statusText: "Unauthorized", headers: {}, config } as AxiosResponse;
        throw new AxiosError("expired", "ERR_BAD_REQUEST", config, undefined, response);
      }
      return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
    };
    const result = await api.post("/attachments/remote-encrypted", {}, {
      headers: { "X-LiaoT-Account-Id": "bob" }, adapter,
    });
    expect(result.data.ok).toBe(true);
    expect(seen).toEqual(["Bearer bob-access", "Bearer bob-recovered"]);
    expect(tokenRequest).toHaveBeenCalledTimes(2);
    expect(getUserToken("alice")).toBe("alice-access");
    expect(getUserToken("bob")).toBe("bob-recovered");
    expect(getUserRefreshToken("bob")).toBe("bob-recovered-refresh");
  });

  it("recovers a missing media token while XMPP is still connected", async () => {
    setupAccounts();
    sessionStorage.removeItem("liaot-user-token:alice");
    sessionStorage.removeItem("liaot-user-refresh:alice");
    setAccountPassword("alice", "alice-password");
    vi.spyOn(axios, "post").mockResolvedValue({
      data: { access_token: "alice-recovered", refresh_token: "alice-new-refresh" },
    });
    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(String(config.headers.Authorization));
      if (config.headers.Authorization !== "Bearer alice-recovered") {
        const response = { data: {}, status: 401, statusText: "Unauthorized", headers: {}, config } as AxiosResponse;
        throw new AxiosError("missing token", "ERR_BAD_REQUEST", config, undefined, response);
      }
      return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
    };
    const result = await api.post("/attachments/remote-encrypted", {}, { adapter });
    expect(result.data.ok).toBe(true);
    expect(seen).toEqual(["undefined", "Bearer alice-recovered"]);
    expect(getUserToken("alice")).toBe("alice-recovered");
  });
});
