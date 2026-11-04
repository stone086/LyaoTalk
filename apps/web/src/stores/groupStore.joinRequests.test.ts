import { afterEach, describe, expect, it } from "vitest";
import { useGroupStore } from "./groupStore";

afterEach(() => useGroupStore.setState({ rooms: {}, members: {}, joinRequests: {} }));

describe("private room join requests", () => {
  it("deduplicates requests per account and clears them when the account is removed", () => {
    const store = useGroupStore.getState();
    store.addJoinRequest("alice", "room@conference.example.org", "guest@example.org");
    store.addJoinRequest("alice", "room@conference.example.org", "guest@example.org");
    store.addJoinRequest("bob", "room@conference.example.org", "guest@example.org");
    expect(useGroupStore.getState().joinRequests["alice::room@conference.example.org"]).toEqual(["guest@example.org"]);
    store.clearAccountData("alice");
    expect(useGroupStore.getState().joinRequests["alice::room@conference.example.org"]).toBeUndefined();
    expect(useGroupStore.getState().joinRequests["bob::room@conference.example.org"]).toEqual(["guest@example.org"]);
  });
});
