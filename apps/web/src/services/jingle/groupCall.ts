/**
 * groupCall.ts - Multi-party calls via mesh topology.
 *
 * Each participant maintains 1:1 JingleSession with every other participant.
 * For N people, that's N×(N-1)/2 sessions. Works well up to 4-6 people.
 * For larger groups, an SFU (selective forwarding unit) would be needed -
 * future work, requires server-side WebRTC infrastructure.
 *
 * Coordination uses XEP-0353 Jingle Message Initiation - we ring all
 * participants by sending <propose> messages, then establish 1:1 calls
 * with whoever accepts.
 */

import { JingleSession } from "./session";
import { CallMediaType, IceServer } from "./types";
import { callManager } from "./index";
import { useAccountStore } from "@/stores/accountStore";

export interface GroupCallParticipant {
  jid: string;
  session?: JingleSession;
  state: "invited" | "ringing" | "joined" | "declined" | "left";
}

export class GroupCall {
  private participants = new Map<string, GroupCallParticipant>();
  private listeners = new Map<string, ((data: any) => void)[]>();
  private startedAt = Date.now();

  constructor(
    public readonly id: string,
    public readonly initiator: string,
    public readonly mediaTypes: CallMediaType[]
  ) {}

  on(event: "participant.joined" | "participant.left" | "participant.state", fn: (data: any) => void): () => void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(fn);
    this.listeners.set(event, arr);
    return () => this.off(event, fn);
  }

  off(event: "participant.joined" | "participant.left" | "participant.state", fn: (data: any) => void) {
    const arr = this.listeners.get(event);
    if (!arr) return;
    this.listeners.set(event, arr.filter(l => l !== fn));
  }

  private emit(event: string, data: any) {
    (this.listeners.get(event) ?? []).forEach(fn => fn(data));
  }

  /**
   * Invite a participant to join the call.
   * Each invitee gets their own 1:1 JingleSession.
   */
  async invite(jid: string): Promise<void> {
    if (this.participants.has(jid)) return;
    this.participants.set(jid, { jid, state: "invited" });
    this.emit("participant.state", { jid, state: "invited" });

    try {
      const accountId = useAccountStore.getState().activeAccountId;
      if (!accountId) throw new Error("No active account");
      const session = await callManager.startCall(accountId, jid, this.mediaTypes);
      const p = this.participants.get(jid);
      if (p) {
        p.session = session;
        p.state = "ringing";
      }
      session.on("state.changed", (state) => {
        const part = this.participants.get(jid);
        if (!part) return;
        if (state === "connected") {
          part.state = "joined";
          this.emit("participant.joined", { jid, session });
        } else if (state === "ended") {
          part.state = "left";
          this.emit("participant.left", { jid });
        }
        this.emit("participant.state", { jid, state: part.state });
      });
    } catch (e) {
      const p = this.participants.get(jid);
      if (p) p.state = "declined";
    }
  }

  getParticipants(): GroupCallParticipant[] {
    return Array.from(this.participants.values());
  }

  getActiveSessions(): JingleSession[] {
    return Array.from(this.participants.values())
      .map(p => p.session)
      .filter((s): s is JingleSession => Boolean(s));
  }

  endAll(): void {
    for (const p of this.participants.values()) {
      p.session?.hangup();
    }
    this.participants.clear();
  }
}

type ManagerEvent = "started" | "ended";
type ManagerListener = (data: any) => void;

class GroupCallManager {
  private active: GroupCall | null = null;
  private listeners = new Map<ManagerEvent, ManagerListener[]>();

  on(event: ManagerEvent, fn: ManagerListener) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  off(event: ManagerEvent, fn: ManagerListener) {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, list.filter((f) => f !== fn));
  }

  private emit(event: ManagerEvent, data?: any) {
    for (const fn of this.listeners.get(event) ?? []) fn(data);
  }

  startGroupCall(initiator: string, mediaTypes: CallMediaType[], inviteJids: string[]): GroupCall {
    if (this.active) {
      this.active.endAll();
    }
    const groupCall = new GroupCall(crypto.randomUUID(), initiator, mediaTypes);
    this.active = groupCall;
    inviteJids.forEach(jid => groupCall.invite(jid).catch(() => {}));
    this.emit("started", groupCall);
    return groupCall;
  }

  getActive(): GroupCall | null {
    return this.active;
  }

  endActive(): void {
    this.active?.endAll();
    this.active = null;
    this.emit("ended");
  }
}

export const groupCallManager = new GroupCallManager();
