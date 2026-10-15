import type { CallSession } from "./types";

export function callOutcome(info: CallSession, endedAt: number) {
  const connectedAt = info.connectedAt;
  return {
    status: connectedAt ? "answered" : info.direction === "incoming" && !info.acceptedAt ? "missed" : "failed",
    durationSeconds: connectedAt ? Math.max(0, Math.round((endedAt - connectedAt) / 1000)) : 0,
  } as const;
}
