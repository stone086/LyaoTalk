/**
 * jingle/types.ts - Common Jingle types.
 *
 * XEPs implemented:
 *   XEP-0166 Jingle (signaling framework)
 *   XEP-0167 Jingle RTP Sessions (audio/video)
 *   XEP-0176 Jingle ICE-UDP Transport
 *   XEP-0234 Jingle File Transfer (future)
 *   XEP-0353 Jingle Message Initiation (call ringing on offline devices)
 */

export type CallDirection = "incoming" | "outgoing";
export type CallState =
  | "idle"
  | "ringing"     // incoming call, waiting for user to accept
  | "calling"    // outgoing, waiting for peer to answer
  | "connecting"  // ICE in progress
  | "connected"
  | "ended";

export type CallMediaType = "audio" | "video";

export interface CallSession {
  id: string;             // session-id, used in Jingle stanzas
  accountId: string;      // local XMPP account that owns the session
  peerJid: string;        // who we're calling / who's calling us
  direction: CallDirection;
  state: CallState;
  mediaTypes: CallMediaType[];
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  startedAt: number;
  acceptedAt?: number;
  connectedAt?: number;
  endedAt?: number;
  errorMessage?: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
