"""Verify Prosody exposes complete MUC membership to ordinary test members.

Run on the test server with /etc/lyaotalk/test-accounts.env and websockets.
The script creates and destroys an isolated, disposable room.
"""
import asyncio
import base64
import secrets
from pathlib import Path

from websockets.asyncio.client import connect


DOMAIN = "lyaot.2-yc.com"
VALUES = dict(line.split("=", 1) for line in Path("/etc/lyaotalk/test-accounts.env").read_text().splitlines())
ROOM = f"omemo-check-{secrets.token_hex(4)}@conference.{DOMAIN}"


async def until(ws, token):
    for _ in range(30):
        stanza = await asyncio.wait_for(ws.recv(), 8)
        if "<error" in stanza or "<stream:error" in stanza:
            raise AssertionError(f"XMPP request rejected: {stanza[:400]}")
        if token in stanza:
            return stanza
    raise AssertionError(f"Missing stanza: {token}")


async def login(jid, password, resource):
    ws = await connect(
        f"wss://{DOMAIN}/xmpp-websocket",
        subprotocols=["xmpp"],
        origin=f"https://{DOMAIN}",
        open_timeout=8,
    )
    await ws.send(f'<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="{DOMAIN}" version="1.0"/>')
    await until(ws, "<mechanisms")
    auth = base64.b64encode(("\0" + jid.split("@")[0] + "\0" + password).encode()).decode()
    await ws.send(f'<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">{auth}</auth>')
    await until(ws, "<success")
    await ws.send(f'<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="{DOMAIN}" version="1.0"/>')
    await until(ws, "<stream:features")
    await ws.send(f'<iq xmlns="jabber:client" type="set" id="bind-{resource}"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>{resource}</resource></bind></iq>')
    await until(ws, f"bind-{resource}")
    await ws.send('<presence xmlns="jabber:client"/>')
    return ws


async def main():
    first = await login(VALUES["TEST1_JID"], VALUES["TEST1_PASS"], "omemo-check-1")
    second = await login(VALUES["TEST2_JID"], VALUES["TEST2_PASS"], "omemo-check-2")
    try:
        await first.send(f'<presence xmlns="jabber:client" to="{ROOM}/tester1"><x xmlns="http://jabber.org/protocol/muc"/></presence>')
        joined = await until(first, f"{ROOM}/tester1")
        assert '201' in joined, f"Room creation did not return status 201: {joined[:400]}"
        await first.send(f'<iq xmlns="jabber:client" to="{ROOM}" type="set" id="cfg"><query xmlns="http://jabber.org/protocol/muc#owner"><x xmlns="jabber:x:data" type="submit"><field var="FORM_TYPE" type="hidden"><value>http://jabber.org/protocol/muc#roomconfig</value></field><field var="muc#roomconfig_membersonly"><value>1</value></field><field var="muc#roomconfig_whois"><value>anyone</value></field><field var="muc#roomconfig_persistentroom"><value>0</value></field></x></query></iq>')
        assert "result" in await until(first, "cfg"), "Room configuration rejected"
        await first.send(f'<iq xmlns="jabber:client" to="{ROOM}" type="set" id="add"><query xmlns="http://jabber.org/protocol/muc#admin"><item jid="{VALUES["TEST2_JID"]}" affiliation="member"/></query></iq>')
        assert "result" in await until(first, "add"), "Member addition rejected"
        await second.send(f'<presence xmlns="jabber:client" to="{ROOM}/tester2"><x xmlns="http://jabber.org/protocol/muc"/></presence>')
        await until(second, f"{ROOM}/tester2")
        for label, ws in (("owner", first), ("member", second)):
            await ws.send(f'<iq xmlns="jabber:client" to="{ROOM}" type="get" id="info-{label}"><query xmlns="http://jabber.org/protocol/disco#info"/></iq>')
            info = await until(ws, f"info-{label}")
            assert "muc_nonanonymous" in info and "muc_membersonly" in info, "Room features absent"
            for affiliation in ("member", "admin", "owner"):
                ident = f"list-{label}-{affiliation}"
                await ws.send(f'<iq xmlns="jabber:client" to="{ROOM}" type="get" id="{ident}"><query xmlns="http://jabber.org/protocol/muc#admin"><item affiliation="{affiliation}"/></query></iq>')
                result = await until(ws, ident)
                assert "result" in result, f"Affiliation query forbidden: {label}/{affiliation}"
        marker = "encrypted-" + secrets.token_hex(8)
        await first.send(f'<message xmlns="jabber:client" to="{ROOM}" type="groupchat" id="{marker}"><body>OMEMO fallback only</body><store xmlns="urn:xmpp:hints"/><no-copy xmlns="urn:xmpp:hints"/><encrypted xmlns="eu.siacs.conversations.axolotl"><header sid="21000"><key rid="21001" prekey="true">dGVzdA==</key><iv>dGVzdA==</iv></header><payload>dGVzdA==</payload></encrypted></message>')
        routed = await until(second, marker)
        assert "eu.siacs.conversations.axolotl" in routed and "dGVzdA==" in routed
        assert "encrypted-plaintext" not in routed
        print("Two-account MUC discovery, affiliation lists and encrypted stanza routing passed")
    finally:
        try:
            await first.send(f'<iq xmlns="jabber:client" to="{ROOM}" type="set" id="destroy"><query xmlns="http://jabber.org/protocol/muc#owner"><destroy/></query></iq>')
        finally:
            await first.close()
            await second.close()


asyncio.run(main())
