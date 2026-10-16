/**
 * jingle/sdp.ts - SDP <-> Jingle XML conversion.
 *
 * WebRTC speaks SDP. XMPP Jingle speaks XML. We convert between them
 * using a subset of jingle-sdp tooling. For full fidelity in production,
 * use the `sdp-jingle-json` library; here we keep an inline implementation
 * sufficient for audio + video + ICE.
 */

import { CallMediaType } from "./types";

interface SdpMedia {
  type: "audio" | "video";
  port: number;
  protocol: string;          // e.g. "UDP/TLS/RTP/SAVPF"
  payloads: string[];        // payload IDs, e.g. "111 103"
  mid: string;               // m-line id
  candidates: string[];      // a=candidate lines
  ufrag?: string;
  pwd?: string;
  fingerprint?: { hash: string; value: string };
  setup?: string;            // actpass / active / passive
  rtpmaps: { id: string; codec: string; clockrate: string; channels?: string }[];
  fmtps: { id: string; params: string }[];
  rtcpFb: { id: string; type: string; subtype?: string }[];
  ssrc?: string;
  ssrcCname?: string;
  direction: "sendrecv" | "sendonly" | "recvonly" | "inactive";
}

/**
 * Parse an SDP string into a structure we can serialize as Jingle XML.
 * Only handles m=audio and m=video lines; ignores m=application (datachannel).
 */
export function parseSdp(sdp: string): SdpMedia[] {
  const lines = sdp.split(/\r?\n/);
  const medias: SdpMedia[] = [];
  let cur: SdpMedia | null = null;
  let sessionUfrag: string | undefined;
  let sessionPwd: string | undefined;
  let sessionFingerprint: { hash: string; value: string } | undefined;
  let sessionSetup: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("m=")) {
      if (cur) medias.push(cur);
      const m = line.match(/^m=(audio|video) (\d+) (\S+) (.+)$/);
      if (!m) { cur = null; continue; }
      cur = {
        type: m[1] as "audio" | "video",
        port: parseInt(m[2], 10),
        protocol: m[3],
        payloads: m[4].split(" "),
        mid: "",
        candidates: [],
        rtpmaps: [],
        fmtps: [],
        rtcpFb: [],
        direction: "sendrecv",
        ufrag: sessionUfrag,
        pwd: sessionPwd,
        fingerprint: sessionFingerprint,
        setup: sessionSetup,
      };
    } else if (cur === null) {
      // Session-level attributes
      const ice = line.match(/^a=ice-ufrag:(.+)$/);
      if (ice) sessionUfrag = ice[1];
      const pwd = line.match(/^a=ice-pwd:(.+)$/);
      if (pwd) sessionPwd = pwd[1];
      const fp = line.match(/^a=fingerprint:(\S+) (.+)$/);
      if (fp) sessionFingerprint = { hash: fp[1], value: fp[2] };
      const setup = line.match(/^a=setup:(\S+)$/);
      if (setup) sessionSetup = setup[1];
    } else {
      const ice = line.match(/^a=ice-ufrag:(.+)$/);
      if (ice) cur.ufrag = ice[1];
      const pwd = line.match(/^a=ice-pwd:(.+)$/);
      if (pwd) cur.pwd = pwd[1];
      const fp = line.match(/^a=fingerprint:(\S+) (.+)$/);
      if (fp) cur.fingerprint = { hash: fp[1], value: fp[2] };
      // Browsers emit a=setup per media section. Losing it turns an answer's
      // "active" role into the default "actpass", which XEP-0320 peers reject.
      const setup = line.match(/^a=setup:(\S+)$/);
      if (setup) cur.setup = setup[1];
      const mid = line.match(/^a=mid:(\S+)$/);
      if (mid) cur.mid = mid[1];
      const cand = line.match(/^a=candidate:(.+)$/);
      if (cand) cur.candidates.push(cand[1]);
      const rtpmap = line.match(/^a=rtpmap:(\S+) (\S+)\/(\d+)(?:\/(\S+))?$/);
      if (rtpmap) cur.rtpmaps.push({ id: rtpmap[1], codec: rtpmap[2], clockrate: rtpmap[3], channels: rtpmap[4] });
      const fmtp = line.match(/^a=fmtp:(\S+) (.+)$/);
      if (fmtp) cur.fmtps.push({ id: fmtp[1], params: fmtp[2] });
      const fb = line.match(/^a=rtcp-fb:(\S+) (\S+)(?: (\S+))?$/);
      if (fb) cur.rtcpFb.push({ id: fb[1], type: fb[2], subtype: fb[3] });
      const ssrc = line.match(/^a=ssrc:(\d+) cname:(.+)$/);
      if (ssrc) { cur.ssrc = ssrc[1]; cur.ssrcCname = ssrc[2]; }
      if (line === "a=sendrecv") cur.direction = "sendrecv";
      else if (line === "a=sendonly") cur.direction = "sendonly";
      else if (line === "a=recvonly") cur.direction = "recvonly";
      else if (line === "a=inactive") cur.direction = "inactive";
    }
  }
  if (cur) medias.push(cur);
  return medias;
}

/**
 * Build an SDP string from a Jingle session description.
 * The reverse of parseSdp - takes our parsed structure and emits SDP
 * suitable for setRemoteDescription().
 */
export function buildSdp(medias: SdpMedia[], type: "offer" | "answer"): string {
  const lines: string[] = [];
  lines.push("v=0");
  lines.push("o=- " + Date.now() + " 1 IN IP4 127.0.0.1");
  lines.push("s=-");
  lines.push("t=0 0");
  if (medias.length > 0) {
    lines.push("a=group:BUNDLE " + medias.map(m => m.mid).join(" "));
  }
  for (const m of medias) {
    lines.push(`m=${m.type} ${m.port || 9} ${m.protocol} ${m.payloads.join(" ")}`);
    lines.push("c=IN IP4 0.0.0.0");
    if (m.ufrag) lines.push(`a=ice-ufrag:${m.ufrag}`);
    if (m.pwd) lines.push(`a=ice-pwd:${m.pwd}`);
    if (m.fingerprint) lines.push(`a=fingerprint:${m.fingerprint.hash} ${m.fingerprint.value}`);
    if (m.setup) lines.push(`a=setup:${m.setup}`);
    lines.push(`a=mid:${m.mid}`);
    lines.push(`a=${m.direction}`);
    lines.push("a=rtcp-mux");
    for (const r of m.rtpmaps) {
      const ch = r.channels ? `/${r.channels}` : "";
      lines.push(`a=rtpmap:${r.id} ${r.codec}/${r.clockrate}${ch}`);
    }
    for (const f of m.fmtps) {
      lines.push(`a=fmtp:${f.id} ${f.params}`);
    }
    for (const fb of m.rtcpFb) {
      const sub = fb.subtype ? ` ${fb.subtype}` : "";
      lines.push(`a=rtcp-fb:${fb.id} ${fb.type}${sub}`);
    }
    for (const c of m.candidates) {
      lines.push(`a=candidate:${c}`);
    }
    if (m.ssrc) {
      lines.push(`a=ssrc:${m.ssrc} cname:${m.ssrcCname || "lyaotalk"}`);
    }
  }
  return lines.join("\r\n") + "\r\n";
}

export type { SdpMedia };
