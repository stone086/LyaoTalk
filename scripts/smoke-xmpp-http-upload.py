#!/usr/bin/env python3
"""End-to-end XEP-0363 smoke check using a disposable test account.

Set TEST1_JID and TEST1_PASS in the environment. Never prints credentials.
"""

import base64
import os
import re
import socket
import ssl
import uuid
import urllib.request
import xml.etree.ElementTree as ET


DOMAIN = "lyaot.2-yc.com"
JID = os.environ["TEST1_JID"]
PASSWORD = os.environ["TEST1_PASS"]
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=="
)


class XmppStream:
    def __init__(self):
        self.sock = socket.create_connection((DOMAIN, 5222), timeout=10)
        self.sock.settimeout(10)
        self.buffer = b""

    def send(self, xml):
        self.sock.sendall(xml.encode())

    def until(self, marker):
        while marker not in self.buffer:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("XMPP stream closed unexpectedly")
            self.buffer += chunk
        end = self.buffer.index(marker) + len(marker)
        result, self.buffer = self.buffer[:end], self.buffer[end:]
        return result

    def open(self):
        self.send(
            f"<stream:stream to='{DOMAIN}' xmlns='jabber:client' "
            "xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>"
        )
        return self.until(b"</stream:features>")

    def iq(self, xml, iq_id):
        self.send(xml)
        pattern = re.compile(rb"<iq\b[^>]*\bid=['\"]" + iq_id.encode() + rb"['\"][^>]*>.*?</iq>", re.S)
        while not pattern.search(self.buffer):
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("XMPP stream closed before IQ reply")
            self.buffer += chunk
        match = pattern.search(self.buffer)
        assert match is not None
        result = ET.fromstring(match.group())
        self.buffer = self.buffer[match.end():]
        if result.get("type") != "result":
            raise RuntimeError(f"XMPP IQ {iq_id} failed: {result.get('type')}")
        return result


stream = XmppStream()
try:
    features = stream.open()
    if b"starttls" not in features:
        raise RuntimeError("STARTTLS not offered")
    stream.send("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>")
    stream.until(b"<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>")
    stream.sock = ssl.create_default_context().wrap_socket(stream.sock, server_hostname=DOMAIN)
    stream.buffer = b""
    features = stream.open()
    if b"PLAIN" not in features:
        raise RuntimeError("SASL PLAIN not offered over TLS")
    auth = base64.b64encode(("\0" + JID.split("@")[0] + "\0" + PASSWORD).encode()).decode()
    stream.send(f"<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>{auth}</auth>")
    stream.until(b"<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>")
    stream.buffer = b""
    stream.open()
    stream.iq(
        "<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>"
        "<resource>upload-smoke</resource></bind></iq>", "bind1"
    )
    items = stream.iq(
        f"<iq type='get' to='{DOMAIN}' id='items1'><query "
        "xmlns='http://jabber.org/protocol/disco#items'/></iq>", "items1"
    )
    if not any(item.get("jid") == f"upload.{DOMAIN}" for item in items.iter()):
        raise RuntimeError("Upload component absent from XMPP service discovery")
    print("XMPP service discovery: upload component present")

    filename = f"smoke-{uuid.uuid4().hex}.png"
    slot = stream.iq(
        f"<iq type='get' to='upload.{DOMAIN}' id='slot1'>"
        f"<request xmlns='urn:xmpp:http:upload:0' filename='{filename}' "
        f"size='{len(PNG)}' content-type='image/png'/></iq>", "slot1"
    )
    get_url = next((e.get("url") for e in slot.iter() if e.tag.endswith("}get")), None)
    put_url = next((e.get("url") for e in slot.iter() if e.tag.endswith("}put")), None)
    if not get_url or not put_url:
        raise RuntimeError("XMPP upload slot did not contain GET and PUT URLs")
    if not (get_url.startswith(f"https://upload.{DOMAIN}/upload/") and put_url.startswith(f"https://upload.{DOMAIN}/upload/")):
        raise RuntimeError("XMPP upload slot returned an unexpected host or path")
    print("XMPP upload slot: granted")

    request = urllib.request.Request(put_url, data=PNG, method="PUT", headers={"Content-Type": "image/png"})
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status not in (200, 201, 204):
            raise RuntimeError(f"Upload PUT returned HTTP {response.status}")
    with urllib.request.urlopen(get_url, timeout=15) as response:
        if response.read() != PNG:
            raise RuntimeError("Downloaded upload differs from sent image")
    print("HTTPS PUT and GET: image bytes match")
finally:
    stream.sock.close()
