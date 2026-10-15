// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { JingleSession } from "./session";

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((event: { candidate: RTCIceCandidate }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicecandidateerror: ((event: { errorCode: number }) => void) | null = null;
  addTrack() {}
  async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
  async setLocalDescription() {
    this.onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 1 203.0.113.1 5000 typ host", sdpMid: "audio" } as RTCIceCandidate });
  }
  close() { this.connectionState = "closed"; }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Jingle call signaling", () => {
  it("sends the offer before ICE candidates gathered during SDP setup", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    const session = new JingleSession("call-1", "bob@example.com/phone", "outgoing", ["audio"], [], "alice");
    const actions: string[] = [];
    session.on("stanza.outgoing", (stanza) => actions.push(stanza.action));
    await session.initiate();
    expect(actions).toEqual(["session-initiate", "transport-info"]);
  });

  it("does not end a call for a brief disconnected WebRTC state", async () => {
    vi.useFakeTimers();
    let pc: FakePeerConnection | undefined;
    vi.stubGlobal("RTCPeerConnection", class extends FakePeerConnection {
      constructor() { super(); pc = this; }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    const session = new JingleSession("call-2", "bob@example.com/phone", "outgoing", ["audio"], [], "alice");
    await session.initiate();
    pc!.connectionState = "connected";
    pc!.onconnectionstatechange?.();
    pc!.connectionState = "disconnected";
    pc!.onconnectionstatechange?.();
    vi.advanceTimersByTime(5000);
    expect(session.state).toBe("connected");
    pc!.connectionState = "connected";
    pc!.onconnectionstatechange?.();
    vi.advanceTimersByTime(15000);
    expect(session.state).toBe("connected");
  });

  it("keeps early peer ICE candidates until the answer is applied", async () => {
    let pc: FakePeerConnection & {
      remoteDescription: RTCSessionDescriptionInit | null;
      added: RTCIceCandidateInit[];
      setRemoteDescription: (description: RTCSessionDescriptionInit) => Promise<void>;
      addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
    } | undefined;
    vi.stubGlobal("RTCPeerConnection", class extends FakePeerConnection {
      remoteDescription: RTCSessionDescriptionInit | null = null;
      added: RTCIceCandidateInit[] = [];
      constructor() { super(); pc = this; }
      async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; }
      async addIceCandidate(candidate: RTCIceCandidateInit) { this.added.push(candidate); }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    const session = new JingleSession("call-3", "bob@example.com/phone", "outgoing", ["audio"], [], "alice");
    await session.initiate();
    const candidate = { candidate: "candidate:1 1 udp 1 203.0.113.1 5000 typ host", sdpMid: "audio" };
    await session.addRemoteCandidate(candidate);
    expect(pc!.added).toHaveLength(0);
    await session.handleAnswer("v=0\r\n");
    expect(pc!.added).toEqual([candidate]);
  });

  it("reports candidate types and ICE errors without exposing candidate addresses", async () => {
    let pc: FakePeerConnection | undefined;
    vi.stubGlobal("RTCPeerConnection", class extends FakePeerConnection {
      constructor() { super(); pc = this; }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    const session = new JingleSession("call-4", "bob@example.com/phone", "outgoing", ["audio"], [], "alice");
    await session.initiate();
    pc!.onicecandidate?.({ candidate: { candidate: "candidate:2 1 udp 1 203.0.113.9 5000 typ relay" } as RTCIceCandidate });
    pc!.onicecandidateerror?.({ errorCode: 701 });
    pc!.connectionState = "failed";
    pc!.onconnectionstatechange?.();
    expect(session.info.errorMessage).toContain("host:1");
    expect(session.info.errorMessage).toContain("relay:1");
    expect(session.info.errorMessage).toContain("server errors:701");
    expect(session.info.errorMessage).not.toContain("203.0.113");
  });

  it("keeps a diagnostic when the peer ends an accepted call before media connects", async () => {
    vi.stubGlobal("RTCPeerConnection", class extends FakePeerConnection {
      remoteDescription = { type: "offer", sdp: "v=0\r\n" };
      async setRemoteDescription() {}
      async createAnswer() { return { type: "answer", sdp: "v=0\r\n" }; }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    const session = new JingleSession("call-5", "bob@example.com/phone", "incoming", ["audio"], [], "alice");
    await session.acceptIncomingOffer("v=0\r\n");
    await session.acceptCall();
    session.remoteHangup("success");
    expect(session.info.errorMessage).toContain("before media connected");
    expect(session.info.errorMessage).toContain("peer: success");
  });

  it("ends a call that remains in connecting for 25 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", class extends FakePeerConnection {
      remoteDescription = { type: "offer", sdp: "v=0\r\n" };
      iceConnectionState = "checking";
      async setRemoteDescription() {}
      async createAnswer() { return { type: "answer", sdp: "v=0\r\n" }; }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    const session = new JingleSession("call-6", "bob@example.com/phone", "incoming", ["audio"], [], "alice");
    await session.acceptIncomingOffer("v=0\r\n");
    await session.acceptCall();
    vi.advanceTimersByTime(25000);
    expect(session.state).toBe("ended");
    expect(session.info.errorMessage).toContain("Media connection timed out (ICE checking");
  });
});
