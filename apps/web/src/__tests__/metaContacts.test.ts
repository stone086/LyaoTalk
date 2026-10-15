import { beforeEach, describe, expect, it } from "vitest";
import { useMetaContactStore } from "../services/metaContacts";

describe("metaContacts store", () => {
  beforeEach(() => {
    useMetaContactStore.setState({ metas: {}, jidToMeta: {} });
    localStorage.clear();
  });

  it("creates a meta-contact and indexes each JID", () => {
    const id = useMetaContactStore.getState().addMeta({
      accountId: "account-1",
      displayName: "Alice",
      primaryJid: "alice@work.test",
      jids: ["alice@work.test", "alice@home.test"],
    });
    const state = useMetaContactStore.getState();
    expect(state.metas[id].displayName).toBe("Alice");
    expect(state.jidToMeta["account-1::alice@work.test"]).toBe(id);
    expect(state.jidToMeta["account-1::alice@home.test"]).toBe(id);
  });

  it("resolves a meta-contact by account and JID", () => {
    const id = useMetaContactStore.getState().addMeta({
      accountId: "account-1",
      displayName: "Bob",
      primaryJid: "bob@example.test",
      jids: ["bob@example.test"],
    });
    expect(useMetaContactStore.getState().getMetaForJid("account-1", "bob@example.test")?.id).toBe(id);
    expect(useMetaContactStore.getState().getMetaForJid("account-1", "other@example.test")).toBeNull();
  });

  it("removes the meta-contact when its final JID is removed", () => {
    const id = useMetaContactStore.getState().addMeta({
      accountId: "account-1",
      displayName: "Solo",
      primaryJid: "solo@example.test",
      jids: ["solo@example.test"],
    });
    useMetaContactStore.getState().removeJidFromMeta(id, "solo@example.test");
    expect(useMetaContactStore.getState().metas[id]).toBeUndefined();
  });
});
