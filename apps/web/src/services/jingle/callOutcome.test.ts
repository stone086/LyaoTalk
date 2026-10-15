import { describe, expect, it } from "vitest";
import { callOutcome } from "./callOutcome";
import type { CallSession } from "./types";

const base: CallSession = {
  id: "call", accountId: "local", peerJid: "peer@example.com",
  direction: "incoming", state: "ended", mediaTypes: ["audio"], startedAt: 1000,
};

describe("call history outcome", () => {
  it("does not count a failed ICE connection as an answered call", () => {
    expect(callOutcome({ ...base, acceptedAt: 4000 }, 22000)).toEqual({
      status: "failed", durationSeconds: 0,
    });
  });

  it("counts only connected time", () => {
    expect(callOutcome({ ...base, acceptedAt: 4000, connectedAt: 18000 }, 23000)).toEqual({
      status: "answered", durationSeconds: 5,
    });
  });

  it("marks an unanswered incoming call missed", () => {
    expect(callOutcome(base, 22000)).toEqual({ status: "missed", durationSeconds: 0 });
  });
});
