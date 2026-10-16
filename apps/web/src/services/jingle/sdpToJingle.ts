/**
 * sdpToJingle.ts - Convert WebRTC SDP into Jingle XML element trees.
 *
 * For each media section in the SDP we build:
 *   <content creator="initiator" name="audio0" senders="both">
 *     <description xmlns="urn:xmpp:jingle:apps:rtp:1" media="audio">
 *       <payload-type id="111" name="opus" clockrate="48000" channels="2">
 *         <parameter name="..." value="..."/>
 *         <rtcp-fb xmlns="urn:xmpp:jingle:apps:rtp:rtcp-fb:0" type="..." subtype="..."/>
 *       </payload-type>
 *       <rtcp-mux/>
 *       <source xmlns="urn:xmpp:jingle:apps:rtp:ssma:0" ssrc="..."/>
 *     </description>
 *     <transport xmlns="urn:xmpp:jingle:transports:ice-udp:1"
 *                ufrag="..." pwd="...">
 *       <fingerprint xmlns="urn:xmpp:jingle:apps:dtls:0" hash="sha-256" setup="actpass">VALUE</fingerprint>
 *       <candidate ip="..." port="..." protocol="udp" type="host" .../>
 *     </transport>
 *   </content>
 *
 * The reverse - jingleToSdp - reconstructs an SDP string usable with
 * RTCPeerConnection.setRemoteDescription.
 *
 * Note: this is a Conversations/Movim-compatible subset that handles
 * audio + video. Datachannels and BUNDLE-only setups need extension.
 */

import { parseSdp, SdpMedia } from "./sdp";

const NS_JINGLE = "urn:xmpp:jingle:1";
const NS_RTP = "urn:xmpp:jingle:apps:rtp:1";
const NS_RTCP_FB = "urn:xmpp:jingle:apps:rtp:rtcp-fb:0";
const NS_SSMA = "urn:xmpp:jingle:apps:rtp:ssma:0";
const NS_ICE = "urn:xmpp:jingle:transports:ice-udp:1";
const NS_DTLS = "urn:xmpp:jingle:apps:dtls:0";

function elementsByName(parent: Element, localName: string, namespace?: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS("*", localName)).filter((el) =>
    !namespace
    || el.namespaceURI === namespace
    || el.getAttribute("xmlns") === namespace
  );
}

function firstElementByName(parent: Element, localName: string, namespace?: string): Element | undefined {
  return elementsByName(parent, localName, namespace)[0];
}

/**
 * Build a Jingle <jingle> Element tree from SDP, ready to insert into an IQ.
 * Returns the serialized XML string of the <jingle> element only.
 */
export function sdpToJingleXml(
  sdp: string,
  action: "session-initiate" | "session-accept",
  sid: string,
  initiator?: string,
  responder?: string
): string {
  const medias = parseSdp(sdp);
  const attrs: Record<string, string> = {
    xmlns: NS_JINGLE,
    action,
    sid,
  };
  if (initiator) attrs.initiator = initiator;
  if (responder) attrs.responder = responder;

  const contents = medias.map((m) => buildContent(m)).join("");
  return `<jingle ${attrsToString(attrs)}>${contents}</jingle>`;
}

/**
 * Convert a Jingle XML <jingle> Element back to an SDP string.
 * For session-initiate -> SDP offer; for session-accept -> SDP answer.
 */
export function jingleXmlToSdp(jingleEl: Element): string {
  const isAnswer = jingleEl.getAttribute("action") === "session-accept";
  const lines: string[] = [
    "v=0",
    `o=- ${Date.now()} 1 IN IP4 0.0.0.0`,
    "s=-",
    "t=0 0",
  ];
  const contents = Array.from(jingleEl.children).filter((c) => c.localName === "content");
  if (contents.length > 0) {
    lines.push("a=group:BUNDLE " + contents.map((c) => c.getAttribute("name") ?? "0").join(" "));
  }
  lines.push("a=msid-semantic: WMS *");

  contents.forEach((contentEl) => {
    const desc = firstElementByName(contentEl, "description", NS_RTP);
    if (!desc) return;
    const media = desc.getAttribute("media") ?? "audio";
    const payloads = elementsByName(desc, "payload-type");
    const ptIds = payloads.map((p) => p.getAttribute("id") ?? "0");

    lines.push(`m=${media} 9 UDP/TLS/RTP/SAVPF ${ptIds.join(" ")}`);
    lines.push("c=IN IP4 0.0.0.0");
    lines.push(`a=mid:${contentEl.getAttribute("name") ?? "0"}`);

    const transport = firstElementByName(contentEl, "transport", NS_ICE);
    if (transport) {
      const ufrag = transport.getAttribute("ufrag");
      const pwd = transport.getAttribute("pwd");
      if (ufrag) lines.push(`a=ice-ufrag:${ufrag}`);
      if (pwd) lines.push(`a=ice-pwd:${pwd}`);
      const fp = firstElementByName(transport, "fingerprint", NS_DTLS);
      if (fp) {
        lines.push(`a=fingerprint:${fp.getAttribute("hash") ?? "sha-256"} ${fp.textContent ?? ""}`);
        // DTLS answers cannot contain actpass. Some Jingle peers omit setup
        // (or echo the offer's actpass), so choose the answerer's active role.
        const advertisedSetup = fp.getAttribute("setup");
        const setup = isAnswer && (!advertisedSetup || advertisedSetup === "actpass")
          ? "active"
          : advertisedSetup ?? "actpass";
        lines.push(`a=setup:${setup}`);
      }
      elementsByName(transport, "candidate").forEach((c) => {
        const relatedAddress = c.getAttribute("rel-addr");
        const relatedPort = c.getAttribute("rel-port");
        lines.push(
          `a=candidate:${c.getAttribute("foundation") ?? "1"} ` +
          `${c.getAttribute("component") ?? "1"} ` +
          `${c.getAttribute("protocol") ?? "udp"} ` +
          `${c.getAttribute("priority") ?? "1"} ` +
          `${c.getAttribute("ip")} ${c.getAttribute("port")} ` +
          `typ ${c.getAttribute("type") ?? "host"}` +
          (relatedAddress && relatedPort ? ` raddr ${relatedAddress} rport ${relatedPort}` : "")
        );
      });
    }

    const senders = contentEl.getAttribute("senders") ?? "both";
    lines.push(`a=${senders === "both" ? "sendrecv" :
                    senders === "initiator" ? "sendonly" :
                    senders === "responder" ? "recvonly" : "inactive"}`);
    lines.push("a=rtcp-mux");

    payloads.forEach((p) => {
      const id = p.getAttribute("id");
      const name = p.getAttribute("name");
      const cr = p.getAttribute("clockrate");
      const ch = p.getAttribute("channels");
      lines.push(`a=rtpmap:${id} ${name}/${cr}${ch && ch !== "1" ? `/${ch}` : ""}`);
      const params = elementsByName(p, "parameter")
        .map((pp) => `${pp.getAttribute("name")}=${pp.getAttribute("value")}`)
        .join(";");
      if (params) lines.push(`a=fmtp:${id} ${params}`);
      elementsByName(p, "rtcp-fb").forEach((fb) => {
        const t = fb.getAttribute("type");
        const sub = fb.getAttribute("subtype");
        lines.push(`a=rtcp-fb:${id} ${t}${sub ? ` ${sub}` : ""}`);
      });
    });

    const ssrcs = elementsByName(desc, "source", NS_SSMA);
    ssrcs.forEach((s) => {
      const ssrc = s.getAttribute("ssrc");
      const cname = elementsByName(s, "parameter")
        .find((p) => p.getAttribute("name") === "cname")
        ?.getAttribute("value") ?? "lyaotalk";
      if (ssrc) lines.push(`a=ssrc:${ssrc} cname:${cname}`);
    });
  });

  return lines.join("\r\n") + "\r\n";
}

/**
 * Build a transport-info Jingle XML for trickling a single ICE candidate.
 */
export function candidateToJingleXml(
  sid: string,
  candidate: RTCIceCandidate,
  contentName: string = "0",
  creator: "initiator" | "responder" = "initiator"
): string {
  // Parse candidate string: candidate:foundation comp proto priority ip port typ <type>
  const m = candidate.candidate.match(
    /^candidate:(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) typ (\S+)/
  );
  if (!m) return "";
  const [, foundation, component, protocol, priority, ip, port, type] = m;
  if (protocol.toLowerCase() !== "udp") return "";
  const relatedAddress = candidate.candidate.match(/\braddr (\S+)/)?.[1];
  const relatedPort = candidate.candidate.match(/\brport (\S+)/)?.[1];
  return `<jingle xmlns="${NS_JINGLE}" action="transport-info" sid="${sid}">` +
    `<content creator="${creator}" name="${contentName}">` +
    `<transport xmlns="${NS_ICE}">` +
    `<candidate foundation="${foundation}" component="${component}" ` +
    `protocol="${protocol}" priority="${priority}" ip="${ip}" port="${port}" ` +
    `type="${type}" generation="0" id="${randId()}"` +
    (relatedAddress && relatedPort ? ` rel-addr="${escape(relatedAddress)}" rel-port="${escape(relatedPort)}"` : "") + `/>` +
    `</transport></content></jingle>`;
}

/**
 * Build a session-terminate stanza.
 */
export function terminateToJingleXml(sid: string, reason: string = "success"): string {
  return `<jingle xmlns="${NS_JINGLE}" action="session-terminate" sid="${sid}">` +
    `<reason><${reason}/></reason></jingle>`;
}

// =====================================================
// Helpers
// =====================================================
function buildContent(m: SdpMedia): string {
  const senders = m.direction === "sendrecv" ? "both" :
                  m.direction === "sendonly" ? "initiator" :
                  m.direction === "recvonly" ? "responder" : "none";
  const desc = buildDescription(m);
  const transport = buildTransport(m);
  return `<content creator="initiator" name="${escape(m.mid || "0")}" senders="${senders}">` +
    desc + transport + `</content>`;
}

function buildDescription(m: SdpMedia): string {
  const payloads = m.rtpmaps.map((rt) => {
    const fmtp = m.fmtps.find((f) => f.id === rt.id);
    const fbs = m.rtcpFb.filter((fb) => fb.id === rt.id);
    const params = fmtp ?
      fmtp.params.split(";").filter(Boolean).map((kv) => {
        const [k, v] = kv.split("=");
        return `<parameter name="${escape(k.trim())}" value="${escape(v?.trim() ?? "")}"/>`;
      }).join("") : "";
    const fbStr = fbs.map((fb) =>
      `<rtcp-fb xmlns="${NS_RTCP_FB}" type="${escape(fb.type)}"${
        fb.subtype ? ` subtype="${escape(fb.subtype)}"` : ""}/>`
    ).join("");
    const channels = rt.channels && rt.channels !== "1" ? ` channels="${rt.channels}"` : "";
    return `<payload-type id="${rt.id}" name="${escape(rt.codec)}" clockrate="${rt.clockrate}"${channels}>` +
      params + fbStr + `</payload-type>`;
  }).join("");

  const ssrc = m.ssrc ?
    `<source xmlns="${NS_SSMA}" ssrc="${m.ssrc}">` +
    `<parameter name="cname" value="${escape(m.ssrcCname ?? "lyaotalk")}"/>` +
    `</source>` : "";

  return `<description xmlns="${NS_RTP}" media="${m.type}">` +
    payloads + `<rtcp-mux/>` + ssrc + `</description>`;
}

function buildTransport(m: SdpMedia): string {
  const ufrag = m.ufrag ? ` ufrag="${escape(m.ufrag)}"` : "";
  const pwd = m.pwd ? ` pwd="${escape(m.pwd)}"` : "";
  const fingerprint = m.fingerprint ?
    `<fingerprint xmlns="${NS_DTLS}" hash="${escape(m.fingerprint.hash)}" ` +
    `setup="${escape(m.setup ?? "actpass")}">${escape(m.fingerprint.value)}</fingerprint>` : "";
  const candidates = m.candidates.map((c) => {
    const parts = c.split(" ");
    if (parts.length < 8) return "";
    const [foundation, component, protocol, priority, ip, port, , type] = parts;
    if (protocol.toLowerCase() !== "udp") return "";
    const relatedAddress = c.match(/\braddr (\S+)/)?.[1];
    const relatedPort = c.match(/\brport (\S+)/)?.[1];
    return `<candidate foundation="${escape(foundation)}" component="${escape(component)}" ` +
      `protocol="${escape(protocol)}" priority="${escape(priority)}" ip="${escape(ip)}" ` +
      `port="${escape(port)}" type="${escape(type)}" generation="0" id="${randId()}"` +
      (relatedAddress && relatedPort ? ` rel-addr="${escape(relatedAddress)}" rel-port="${escape(relatedPort)}"` : "") + `/>`;
  }).join("");
  return `<transport xmlns="${NS_ICE}"${ufrag}${pwd}>` +
    fingerprint + candidates + `</transport>`;
}

function attrsToString(a: Record<string, string>): string {
  return Object.entries(a).map(([k, v]) => `${k}="${escape(v)}"`).join(" ");
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"
  }[c]!));
}

function randId(): string {
  return Math.random().toString(36).slice(2, 12);
}

export { NS_JINGLE };

