"""Live private-file isolation test with two temporary LiaoT accounts."""
import asyncio
import secrets
import subprocess
from pathlib import Path

import asyncpg
import httpx
from minio import Minio

values = dict(line.strip().split("=", 1) for line in Path("/etc/liaot/secrets.env").read_text().splitlines() if "=" in line)
base = "https://liaot.2-yc.com/api"
users = [("fileaccept" + secrets.token_hex(4), secrets.token_urlsafe(20)) for _ in range(2)]
accounts = []
object_key = None


async def cleanup():
    for name, _ in users:
        subprocess.run(["prosodyctl", "deluser", f"{name}@liaot.2-yc.com"], capture_output=True)
    if accounts:
        conn = await asyncpg.connect(user="liaot", password=values["DB_PASS"], database="liaot", host="127.0.0.1")
        try:
            for account_id in accounts:
                await conn.execute("DELETE FROM attachments WHERE owner_account_id=$1", account_id)
                await conn.execute("DELETE FROM account_preferences WHERE account_id=$1", account_id)
                await conn.execute("DELETE FROM accounts WHERE id=$1", account_id)
        finally:
            await conn.close()
    if object_key:
        Minio("127.0.0.1:9000", access_key=values["MINIO_ROOT_USER"], secret_key=values["MINIO_ROOT_PASSWORD"], secure=False).remove_object("liaot-files", object_key)


try:
    with httpx.Client(timeout=20) as client:
        tokens = []
        for name, password in users:
            jid = f"{name}@liaot.2-yc.com"
            assert client.post(base + "/auth/register", json={"jid": jid, "password": password}).status_code == 200
            response = client.post(base + "/auth/user-token", json={"jid": jid, "password": password})
            assert response.status_code == 200, response.text[:150]
            tokens.append(response.json()["access_token"])
            accounts.append(response.json()["account_id"])
        upload = client.post(base + "/attachments/upload", headers={"Authorization": "Bearer " + tokens[0]}, files={"file": ("private.txt", b"private LiaoT test", "text/plain")})
        assert upload.status_code == 200, upload.text[:150]
        object_key = upload.json()["object_key"]
        print("upload", upload.status_code)
        api_url = base + "/attachments/download/" + object_key
        own = client.get(api_url, headers={"Authorization": "Bearer " + tokens[0]})
        print("own_download", own.status_code, own.content == b"private LiaoT test")
        assert own.status_code == 200 and own.content == b"private LiaoT test"
        other = client.get(api_url, headers={"Authorization": "Bearer " + tokens[1]})
        print("other_account", other.status_code)
        assert other.status_code == 404
        anonymous = client.get(api_url)
        print("anonymous", anonymous.status_code)
        assert anonymous.status_code == 401
        query_token = client.get(api_url + "?t=" + tokens[0])
        print("query_token", query_token.status_code)
        assert query_token.status_code == 401
        upload_url = "https://upload.liaot.2-yc.com/files/" + object_key
        host_download = client.get(upload_url, headers={"Authorization": "Bearer " + tokens[0]})
        print("upload_host_header", host_download.status_code, host_download.content == b"private LiaoT test")
        assert host_download.status_code == 200 and host_download.content == b"private LiaoT test"
        host_query_token = client.get(upload_url + "?t=" + tokens[0])
        print("upload_host_query_token", host_query_token.status_code)
        assert host_query_token.status_code == 401
finally:
    asyncio.run(cleanup())
