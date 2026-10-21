// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { getIdentityFingerprint } from "./keys";
import { OmemoStore } from "./store";

describe("OMEMO device identity", () => {
  it("shows the persisted libsignal identity for each device separately", async () => {
    const first = new Uint8Array([0x05, 0x01, 0x23, 0x45, 0x67]).buffer;
    const second = new Uint8Array([0x05, 0x89, 0xab, 0xcd, 0xef]).buffer;
    await new OmemoStore("account-on-phone").storeIdentity({ pubKey: first, privKey: first }, 111);
    await new OmemoStore("account-on-laptop").storeIdentity({ pubKey: second, privKey: second }, 222);

    expect(await getIdentityFingerprint("account-on-phone")).toBe("01234567");
    expect(await getIdentityFingerprint("account-on-laptop")).toBe("89abcdef");
    expect(await getIdentityFingerprint("account-on-phone")).toBe("01234567");
  });
});
