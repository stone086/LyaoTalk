"""Read the current Prosody internal-auth credential revision over a local socket.

The helper runs as the Prosody user and only returns a digest of file metadata.
No password hash or account file contents cross the socket.
"""
import json
import re
import socket

from fastapi import HTTPException

SOCKET_PATH = "/run/liaot-prosody.sock"


def get_credential_revision(jid: str) -> str:
    try:
        username, domain = jid.split("@", 1)
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", username) or not re.fullmatch(r"[A-Za-z0-9.-]{1,64}", domain):
            raise ValueError("invalid jid")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(2)
            conn.connect(SOCKET_PATH)
            conn.sendall((json.dumps({"action": "credential_revision", "username": username, "domain": domain}) + "\n").encode())
            data = b""
            while b"\n" not in data and len(data) < 1024:
                chunk = conn.recv(1024)
                if not chunk:
                    break
                data += chunk
        reply = json.loads(data.split(b"\n", 1)[0])
        revision = reply.get("revision")
        if reply.get("returncode") != 0 or not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{64}", revision):
            raise ValueError("revision unavailable")
        return revision
    except (OSError, ValueError, KeyError, json.JSONDecodeError, IndexError) as exc:
        raise HTTPException(status_code=503, detail="Prosody credential revision unavailable") from exc
