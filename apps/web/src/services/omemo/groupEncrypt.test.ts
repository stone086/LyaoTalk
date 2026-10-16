// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
  (globalThis as typeof globalThis & { XMLHttpRequest: unknown }).XMLHttpRequest = class {
    getResponseHeader() { return null; }
  };
});
import { KeyHelper } from "@privacyresearch/libsignal-protocol-typescript/lib/key-helper";

const data = new Map<string, unknown>();
vi.mock("./store", () => ({
  OmemoStore: class {
    constructor(private account: string) {}
    private key(name: string) { return `${this.account}:${name}`; }
    async getIdentityKeyPair() { return data.get(this.key("identity")); }
    async getLocalRegistrationId() { return data.get(this.key("registration")); }
    async storeIdentity(pair: unknown, id: number) { data.set(this.key("identity"), pair); data.set(this.key("registration"), id); }
    async isTrustedIdentity() { return true; }
    async loadIdentityKey(name: string) { return data.get(this.key(`identity:${name}`)); }
    async saveIdentity(name: string, key: unknown) { data.set(this.key(`identity:${name}`), key); return false; }
    async loadPreKey(id: number) { return data.get(this.key(`prekey:${id}`)); }
    async storePreKey(id: number, key: unknown) { data.set(this.key(`prekey:${id}`), key); }
    async removePreKey(id: number) { data.delete(this.key(`prekey:${id}`)); }
    async loadSignedPreKey(id: number) { return data.get(this.key(`signed:${id}`)); }
    async storeSignedPreKey(id: number, key: unknown) { data.set(this.key(`signed:${id}`), key); }
    async loadSession(name: string) { return data.get(this.key(`session:${name}`)); }
    async storeSession(name: string, value: unknown) { data.set(this.key(`session:${name}`), value); }
    async removeSession(name: string) { data.delete(this.key(`session:${name}`)); }
  },
}));

import { decryptEnvelope, encryptForDevices, establishSession } from "./encrypt";

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});

describe("group OMEMO key fanout", () => {
  it("encrypts one payload for two distinct members and decrypts it on both devices", async () => {
    const members = ["alice@example.test", "bob@example.test", "carol@example.test"];
    const bundles = [];
    for (let index = 0; index < members.length; index++) {
      const identity = await KeyHelper.generateIdentityKeyPair();
      const registration = index === 0 ? 21000 : 21001;
      const signed = await KeyHelper.generateSignedPreKey(identity, 1);
      const prekey = await KeyHelper.generatePreKey(1);
      data.set(`${members[index]}:identity`, identity);
      data.set(`${members[index]}:registration`, registration);
      data.set(`${members[index]}:signed:1`, signed.keyPair);
      data.set(`${members[index]}:prekey:1`, prekey.keyPair);
      bundles.push({
        deviceId: registration,
        identityKey: identity.pubKey,
        signedPreKeyId: 1,
        signedPreKey: signed.keyPair.pubKey,
        signedPreKeySignature: signed.signature,
        preKey: { keyId: 1, publicKey: prekey.keyPair.pubKey },
      });
    }
    await establishSession(members[0], members[1], bundles[1]);
    await establishSession(members[0], members[2], bundles[2]);
    const plaintext = "group message 🔒";
    const envelope = await encryptForDevices(members[0], bundles[0].deviceId, plaintext, [
      { peerJid: members[1], deviceId: bundles[1].deviceId },
      { peerJid: members[2], deviceId: bundles[2].deviceId },
    ]);
    expect(envelope.keys).toHaveLength(2);
    expect(envelope.keys[0].rid).toBe(envelope.keys[1].rid);
    expect(await decryptEnvelope(members[1], bundles[1].deviceId, members[0], envelope)).toBe(plaintext);
    expect(await decryptEnvelope(members[2], bundles[2].deviceId, members[0], envelope)).toBe(plaintext);
  });
});

