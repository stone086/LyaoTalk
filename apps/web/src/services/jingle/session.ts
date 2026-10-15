/**
 * jingle/session.ts - Jingle session management with WebRTC.
 *
 * Each call instantiates a JingleSession that wraps:
 *   - RTCPeerConnection (WebRTC)
 *   - SDP offer/answer translated to/from Jingle XML
 *   - ICE candidate exchange via session-info
 *
 * The session emits events that the bridge layer subscribes to:
 *   "state.changed"        - call state transitions (ringing/connecting/...)
 *   "stanza.outgoing"       - a Jingle stanza needs to be sent to the peer
 *   "stream.local"          - local MediaStream ready (preview)
 *   "stream.remote"         - remote MediaStream received
 *   "ended"                 - session terminated
 */

import { CallSession, CallState, CallMediaType, IceServer } from "./types";
import { parseSdp, buildSdp, SdpMedia } from "./sdp";

type Listener = (data: any) => void;

export class JingleSession {
  private pc: RTCPeerConnection | null = null;
  private listeners = new Map<string, Listener[]>();
  private session: CallSession;
  private _screenStream: MediaStream | null = null;
  private iceServers: IceServer[];
  private localCandidates: RTCIceCandidate[] = [];
  private remoteCandidates: RTCIceCandidateInit[] = [];
  private localCandidateTypes = new Map<string, number>();
  private remoteCandidateTypes = new Map<string, number>();
  private rejectedRemoteCandidates = 0;
  private iceServerErrorCodes = new Set<number>();
  private signalingStarted = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    sessionId: string,
    peerJid: string,
    direction: "incoming" | "outgoing",
    mediaTypes: CallMediaType[],
    iceServers: IceServer[],
    accountId: string
  ) {
    this.session = {
      id: sessionId,
      accountId,
      peerJid,
      direction,
      state: direction === "incoming" ? "ringing" : "calling",
      mediaTypes,
      startedAt: Date.now(),
    };
    this.iceServers = iceServers;
  }

  on(event: string, fn: Listener): () => void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(fn);
    this.listeners.set(event, arr);
    return () => this.off(event, fn);
  }

  off(event: string, fn: Listener) {
    const arr = this.listeners.get(event);
    if (!arr) return;
    this.listeners.set(event, arr.filter(l => l !== fn));
  }

  private emit(event: string, data?: any) {
    (this.listeners.get(event) ?? []).forEach(fn => fn(data));
  }

  get state(): CallState { return this.session.state; }
  get info(): CallSession { return { ...this.session }; }

  private setState(state: CallState) {
    this.session.state = state;
    this.emit("state.changed", state);
  }

  private async ensurePc() {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.countCandidate(this.localCandidateTypes, ev.candidate.candidate);
        // The peer cannot apply transport-info before session-initiate or
        // session-accept. Queue candidates gathered during local SDP setup.
        if (this.signalingStarted) this.sendCandidate(ev.candidate);
        else this.localCandidates.push(ev.candidate);
      }
    };

    pc.onicecandidateerror = (event) => {
      if (event.errorCode) this.iceServerErrorCodes.add(event.errorCode);
    };

    pc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0]) {
        this.session.remoteStream = ev.streams[0];
        this.emit("stream.remote", ev.streams[0]);
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        this.session.connectedAt ??= Date.now();
        this.setState("connected");
      } else if (s === "failed") {
        this.session.errorMessage = this.iceFailureSummary();
        this.hangup("failed-transport");
      } else if (s === "disconnected" && !this.disconnectTimer) {
        // A brief network change can recover without renegotiation.
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (pc.connectionState === "disconnected") this.hangup("failed-transport");
        }, 10000);
      }
    };

    return pc;
  }

  private async getLocalMedia(): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      audio: this.session.mediaTypes.includes("audio"),
      video: this.session.mediaTypes.includes("video")
        ? { width: 1280, height: 720 }
        : false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.session.localStream = stream;
    this.emit("stream.local", stream);
    return stream;
  }

  /**
   * Initiator: create offer, attach local tracks, emit session-initiate.
   */
  async initiate() {
    const pc = await this.ensurePc();
    const stream = await this.getLocalMedia();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.setState("connecting");
    this.emit("stanza.outgoing", {
      action: "session-initiate",
      sdp: offer.sdp,
      mediaTypes: this.session.mediaTypes,
    });
    this.startCandidateSignaling();
    this.startConnectionTimeout();
  }

  /**
   * Receiver: handle incoming session-initiate (peer's offer).
   */
  async acceptIncomingOffer(sdp: string) {
    const pc = await this.ensurePc();
    await pc.setRemoteDescription({ type: "offer", sdp });
    await this.flushRemoteCandidates();
  }

  /**
   * Receiver: user accepted the call; send answer.
   */
  async acceptCall() {
    if (!this.pc) throw new Error("No incoming offer received");
    this.session.acceptedAt = Date.now();
    const stream = await this.getLocalMedia();
    stream.getTracks().forEach(t => this.pc!.addTrack(t, stream));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.setState("connecting");
    this.emit("stanza.outgoing", {
      action: "session-accept",
      sdp: answer.sdp,
    });
    this.startCandidateSignaling();
    this.startConnectionTimeout();
  }

  /**
   * Initiator: handle peer's answer.
   */
  async handleAnswer(sdp: string) {
    if (!this.pc) throw new Error("No peer connection");
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    await this.flushRemoteCandidates();
  }

  /**
   * Either side: peer sent us an ICE candidate.
   */
  async addRemoteCandidate(candidate: RTCIceCandidateInit) {
    if (!this.pc) return;
    if (!this.pc.remoteDescription) {
      this.remoteCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
      this.countCandidate(this.remoteCandidateTypes, candidate.candidate ?? "");
    } catch {
      this.rejectedRemoteCandidates++;
    }
  }

  private countCandidate(target: Map<string, number>, candidate: string) {
    const type = candidate.match(/\btyp\s+(host|srflx|prflx|relay)\b/i)?.[1]?.toLowerCase();
    if (type) target.set(type, (target.get(type) ?? 0) + 1);
  }

  private iceFailureSummary() {
    const types = (counts: Map<string, number>) => ["host", "srflx", "prflx", "relay"]
      .map((type) => `${type}:${counts.get(type) ?? 0}`).join(" ");
    const codes = [...this.iceServerErrorCodes].sort((a, b) => a - b).join(",") || "none";
    return `ICE failed (local ${types(this.localCandidateTypes)}; remote ${types(this.remoteCandidateTypes)}; rejected:${this.rejectedRemoteCandidates}; server errors:${codes})`;
  }

  private startConnectionTimeout() {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = setTimeout(() => {
      this.connectionTimer = null;
      if (this.session.state !== "connecting") return;
      const iceState = this.pc?.iceConnectionState ?? "unknown";
      this.session.errorMessage = `Media connection timed out (ICE ${iceState}; ${this.iceFailureSummary()})`;
      this.hangup("failed-transport");
    }, 25000);
  }

  private async flushRemoteCandidates() {
    const queued = this.remoteCandidates;
    this.remoteCandidates = [];
    for (const candidate of queued) await this.addRemoteCandidate(candidate);
  }

  /**
   * Hang up. Sends session-terminate to peer.
   */
  hangup(reason: string = "success") {
    this.setState("ended");
    this.session.endedAt = Date.now();
    this.emit("stanza.outgoing", {
      action: "session-terminate",
      reason,
    });
    this.cleanup();
  }

  /**
   * Peer terminated the session.
   */
  remoteHangup(reason?: string) {
    if (this.session.acceptedAt && !this.session.connectedAt && !this.session.errorMessage) {
      this.session.errorMessage = `Call ended before media connected (peer: ${reason ?? "unknown"}; ${this.iceFailureSummary()})`;
    }
    this.setState("ended");
    this.session.endedAt = Date.now();
    this.cleanup();
  }

  private cleanup() {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    this.session.localStream?.getTracks().forEach(t => t.stop());
    this._screenStream?.getTracks().forEach(t => t.stop());
    this._screenStream = null;
    this.remoteCandidates = [];
    this.pc?.close();
    this.pc = null;
    this.emit("ended");
  }

  private sendCandidate(candidate: RTCIceCandidate) {
    this.emit("stanza.outgoing", { action: "transport-info", candidate });
  }

  private startCandidateSignaling() {
    this.signalingStarted = true;
    this.localCandidates.forEach((candidate) => this.sendCandidate(candidate));
    this.localCandidates = [];
  }

  /**
   * Toggle local microphone mute.
   */
  setMuted(muted: boolean) {
    this.session.localStream?.getAudioTracks().forEach(t => t.enabled = !muted);
  }

  /**
   * Toggle local camera off.
   */
  setVideoEnabled(enabled: boolean) {
    this.session.localStream?.getVideoTracks().forEach(t => t.enabled = enabled);
  }

  /**
   * Replace the camera track with a screen share track.
   * Returns true if the user accepted the screen-share permission.
   */
  async startScreenShare(): Promise<boolean> {
    if (!this.pc) return false;
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) {
        screenStream.getTracks().forEach(t => t.stop());
        return false;
      }

      // Track for later cleanup
      this._screenStream = screenStream;

      // Find the existing video sender and replace its track
      const sender = this.pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) {
        await sender.replaceTrack(screenTrack);
      } else {
        this.pc.addTrack(screenTrack, screenStream);
      }

      // When user stops sharing via browser UI, restore camera
      screenTrack.onended = () => {
        this.stopScreenShare().catch(() => {});
      };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Switch back to camera after screen sharing.
   */
  async stopScreenShare(): Promise<void> {
    // Stop the screen-share stream regardless of whether the swap succeeds
    if (this._screenStream) {
      this._screenStream.getTracks().forEach(t => t.stop());
      this._screenStream = null;
    }
    if (!this.pc) return;
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const camTrack = camStream.getVideoTracks()[0];
      const sender = this.pc.getSenders().find(s => s.track?.kind === "video");
      if (sender && camTrack) {
        await sender.replaceTrack(camTrack);
        // Stop any other tracks from the stream we don't end up using (e.g. audio
        // tracks if the constraint was wide). The video track stays alive because
        // it's now owned by the RTCRtpSender.
        camStream.getTracks().forEach(t => {
          if (t !== camTrack) t.stop();
        });
      } else {
        // Couldn't attach the new track — release everything to free the camera
        camStream.getTracks().forEach(t => t.stop());
      }
    } catch {
      // Camera unavailable - just remove the video track
      const sender = this.pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(null);
    }
  }

  /**
   * Start recording the call (local recording, not server-side).
   * Records the remote stream + local audio mixed via MediaRecorder.
   * Returns a function that stops recording and returns a Blob.
   */
  startRecording(): (() => Promise<Blob>) | null {
    if (!this.session.remoteStream) return null;
    const mixed = new MediaStream();
    this.session.remoteStream.getTracks().forEach(t => mixed.addTrack(t));
    this.session.localStream?.getAudioTracks().forEach(t => mixed.addTrack(t));

    const recorder = new MediaRecorder(mixed, {
      mimeType: "video/webm;codecs=vp9,opus",
      videoBitsPerSecond: 2_500_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start(1000); // 1s chunks

    return () => new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: "video/webm" }));
      };
      recorder.stop();
    });
  }
}
