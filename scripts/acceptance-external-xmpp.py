"""Exercise federation with an externally owned XMPP account.

Run on the LyaoTalk host. The external password is read from the terminal and is
never stored in a file or passed as a command-line argument.
"""
import asyncio
import getpass
import secrets
import subprocess
import xml.etree.ElementTree as ET

import slixmpp


DOMAIN = "lyaot.2-yc.com"
EXTERNAL_JID = "test1@chat.52nbc.com"


class Client(slixmpp.ClientXMPP):
    def __init__(self, jid: str, password: str):
        super().__init__(jid, password)
        self.ready = asyncio.Event()
        self.messages = asyncio.Queue()
        self.errors = asyncio.Queue()
        self.add_event_handler("session_start", self.on_start)
        self.add_event_handler("message", self.on_message)
        self.add_event_handler("message_error", self.on_error)
        self.register_plugin("xep_0060")

    async def on_start(self, _event):
        self.send_presence()
        await self.get_roster()
        self.ready.set()

    def on_message(self, message):
        if message["body"]:
            self.messages.put_nowait(message)

    def on_error(self, message):
        self.errors.put_nowait(str(message["error"]["condition"]))


async def receive(client: Client, expected: str, seconds: int = 25):
    while True:
        message = await asyncio.wait_for(client.messages.get(), seconds)
        if str(message["body"]) == expected:
            return


async def main():
    password = getpass.getpass("External XMPP password: ")
    suffix = secrets.token_hex(4)
    username = f"lyaotalkfed{suffix}"
    local_jid = f"{username}@{DOMAIN}"
    local_password = secrets.token_urlsafe(24)
    clients = []
    try:
        subprocess.run(
            ["prosodyctl", "register", username, DOMAIN, local_password],
            check=True, capture_output=True,
        )
        local = Client(local_jid, local_password)
        external = Client(EXTERNAL_JID, password)
        clients.extend((local, external))
        await asyncio.wait_for(local.connect(host="127.0.0.1", port=5222), 15)
        await asyncio.wait_for(external.connect(host="chat.52nbc.com", port=5222), 15)
        await asyncio.wait_for(asyncio.gather(local.ready.wait(), external.ready.wait()), 20)
        print("PASS: both servers authenticated the test accounts")

        outbound = f"lyaotalk-outbound-{suffix}"
        local.send_message(mto=EXTERNAL_JID, mbody=outbound, mtype="chat")
        await receive(external, outbound)
        print("PASS: LyaoTalk to external message delivered")

        inbound = f"lyaotalk-inbound-{suffix}"
        external.send_message(mto=local_jid, mbody=inbound, mtype="chat")
        delivery = asyncio.create_task(receive(local, inbound))
        rejection = asyncio.create_task(external.errors.get())
        try:
            done, _ = await asyncio.wait({delivery, rejection}, timeout=30, return_when=asyncio.FIRST_COMPLETED)
            if rejection in done:
                raise RuntimeError(f"Remote server rejected the message: {rejection.result()}")
            if delivery not in done:
                raise TimeoutError("External to LyaoTalk message did not arrive within 30 seconds")
            await delivery
        finally:
            delivery.cancel()
            rejection.cancel()
        print("PASS: external to LyaoTalk message delivered")

        # Device discovery is needed before an external client can encrypt to
        # the existing LyaoTalk user. Do not read or print any private key data.
        for node in (
            "eu.siacs.conversations.axolotl.devicelist",
            "urn:xmpp:omemo:2:devices",
        ):
            try:
                result = await external.plugin["xep_0060"].get_items(
                    "shitou@lyaot.2-yc.com", node, timeout=10,
                )
                if result["type"] == "error":
                    print(f"OMEMO device discovery {node}: {result['error']['condition']}")
                else:
                    print(f"OMEMO device discovery {node}: {len(result['pubsub']['items'])} item(s)")
                    device_ids = {
                        element.get("id")
                        for element in ET.fromstring(str(result)).iter()
                        if element.tag.rsplit("}", 1)[-1] == "device" and element.get("id")
                    }
                    for device_id in sorted(device_ids):
                        bundle_node = node.replace("devicelist", f"bundles:{device_id}").replace("devices", f"bundles:{device_id}")
                        bundle = await external.plugin["xep_0060"].get_items(
                            "shitou@lyaot.2-yc.com", bundle_node, timeout=10,
                        )
                        status = bundle["error"]["condition"] if bundle["type"] == "error" else "available"
                        print(f"OMEMO bundle {node} device {device_id}: {status}")
            except Exception as exc:
                print(f"OMEMO device discovery {node}: {type(exc).__name__}")
    finally:
        for client in clients:
            client.disconnect()
        await asyncio.sleep(0.5)
        subprocess.run(["prosodyctl", "deluser", local_jid], capture_output=True)


if __name__ == "__main__":
    asyncio.run(main())
