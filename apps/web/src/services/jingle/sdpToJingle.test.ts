// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { candidateToJingleXml, jingleXmlToSdp, sdpToJingleXml } from "./sdpToJingle";

describe("Jingle DTLS answer", () => {
  it.each(["", ' setup="actpass"'])("uses an active DTLS role for an answer with setup %s", (setup) => {
    const xml = new DOMParser().parseFromString(
      `<jingle xmlns="urn:xmpp:jingle:1" action="session-accept">
        <content name="0"><description xmlns="urn:xmpp:jingle:apps:rtp:1" media="audio">
          <payload-type id="111" name="opus" clockrate="48000" channels="2"/>
        </description><transport xmlns="urn:xmpp:jingle:transports:ice-udp:1" ufrag="abc" pwd="longpassword">
          <fingerprint xmlns="urn:xmpp:jingle:apps:dtls:0" hash="sha-256"${setup}>AA:BB</fingerprint>
        </transport></content>
      </jingle>`, "text/xml",
    ).documentElement;
    expect(jingleXmlToSdp(xml)).toContain("a=setup:active\r\n");
  });

  it("parses prefixed RTP and ICE elements from a federated client", () => {
    const xml = new DOMParser().parseFromString(
      `<j:jingle xmlns:j="urn:xmpp:jingle:1" action="session-accept">
        <j:content name="0"><r:description xmlns:r="urn:xmpp:jingle:apps:rtp:1" media="audio">
          <r:payload-type id="111" name="opus" clockrate="48000" channels="2"/>
        </r:description><i:transport xmlns:i="urn:xmpp:jingle:transports:ice-udp:1" ufrag="abc" pwd="longpassword">
          <d:fingerprint xmlns:d="urn:xmpp:jingle:apps:dtls:0" hash="sha-256" setup="active">AA:BB</d:fingerprint>
        </i:transport></j:content>
      </j:jingle>`, "text/xml",
    ).documentElement;
    const sdp = jingleXmlToSdp(xml);
    expect(sdp).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n");
    expect(sdp).toContain("a=ice-ufrag:abc\r\n");
  });
});

describe("Jingle DTLS role from browser SDP", () => {
  it("keeps the media-level a=setup:active of a browser answer", () => {
    // Chrome places a=setup inside each m= section, not at session level.
    const answer = [
      "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0",
      "a=ice-ufrag:abcd", "a=ice-pwd:0123456789abcdefghijkl",
      "a=fingerprint:sha-256 AA:BB", "a=setup:active", "a=mid:0",
      "a=sendrecv", "a=rtcp-mux", "a=rtpmap:111 opus/48000/2", "",
    ].join("\r\n");
    const xml = sdpToJingleXml(answer, "session-accept", "call-3");
    expect(xml).toContain('setup="active"');
    expect(xml).not.toContain('setup="actpass"');
  });
});

describe("ICE candidate conversion", () => {
  it("preserves related address and port across Jingle transport-info", () => {
    const candidate = { candidate: "candidate:2 1 udp 1686052607 203.0.113.5 50000 typ srflx raddr 10.0.0.5 rport 43000" } as RTCIceCandidate;
    const xml = candidateToJingleXml("call-1", candidate, "audio");
    expect(xml).toContain('rel-addr="10.0.0.5"');
    expect(xml).toContain('rel-port="43000"');
  });

  it("does not put TCP candidates in an ICE-UDP transport", () => {
    const candidate = { candidate: "candidate:3 1 tcp 1518280447 203.0.113.5 9 typ host tcptype active" } as RTCIceCandidate;
    expect(candidateToJingleXml("call-2", candidate)).toBe("");
  });
});

