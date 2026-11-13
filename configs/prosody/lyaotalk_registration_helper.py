"""Narrow Prosody account registration service on a systemd Unix socket."""

import json
import os
import re
import socket
import stat
import subprocess
import hashlib
from urllib.parse import unquote


DOMAIN = os.environ.get("LYAOTALK_XMPP_DOMAIN", "")
DATA_ROOT = os.environ.get("LYAOTALK_PROSODY_DATA_ROOT", "/var/lib/prosody")


def _shell(*args: str) -> dict:
    result = subprocess.run(
        [b"/usr/bin/prosodyctl", b"shell", *(arg.encode("utf-8") for arg in args)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, check=False,
    )
    ok = result.returncode == 0 and "Error:" not in result.stdout and "console:" not in result.stdout
    return {"returncode": 0 if ok else 1, "stdout": result.stdout[:16384],
            "stderr": result.stderr[:2048]}


def _encoded_name(value: str) -> str:
    """Match Prosody internal storage's lowercase percent-encoded path names."""
    return "".join(chr(byte) if 0x30 <= byte <= 0x39 or 0x61 <= byte <= 0x7a else f"%{byte:02x}" for byte in value.lower().encode("utf-8"))


def credential_revision(username: str, domain: str) -> str:
    if not isinstance(username, str) or (not re.fullmatch(r"[\w.-]{1,64}", username) or len(username.encode("utf-8")) > 64):
        raise ValueError("invalid username")
    if domain != DOMAIN:
        raise ValueError("invalid domain")
    path = os.path.join(DATA_ROOT, _encoded_name(domain), "accounts", _encoded_name(username) + ".dat")
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("account is not a regular file")
    marker = f"{info.st_dev}:{info.st_ino}:{info.st_ctime_ns}:{info.st_size}"
    return hashlib.sha256(marker.encode()).hexdigest()


def handle(conn: socket.socket) -> None:
    conn.settimeout(20)
    data = b""
    while b"\n" not in data and len(data) <= 4096:
        chunk = conn.recv(1024)
        if not chunk:
            return
        data += chunk
    try:
        request = json.loads(data.split(b"\n", 1)[0])
        domain = request["domain"]
        action = request.get("action", "register")
        if domain != DOMAIN:
            raise ValueError("invalid domain")
        if action == "list_rooms":
            path = os.path.join(DATA_ROOT, _encoded_name(f"conference.{domain}"), "config")
            rooms = []
            for entry in os.scandir(path):
                if entry.name.endswith(".dat") and entry.is_file(follow_symlinks=False):
                    rooms.append(f"{unquote(entry.name[:-4])}@conference.{domain}")
            response = {"returncode": 0, "rooms": sorted(rooms)[:500]}
        elif action == "list_users":
            result = _shell("user", "list", domain)
            if result["returncode"]:
                response = result
            else:
                users = [line.strip() for line in result["stdout"].splitlines()
                         if line.strip().endswith(f"@{domain}")]
                response = {"returncode": 0, "users": users[:1000]}
        elif action == "online_sessions":
            result = _shell("c2s", "show")
            response = {"returncode": result["returncode"], "output": result["stdout"][:12000]}
        elif action == "room_members":
            room = request["room"]
            if not isinstance(room, str) or not re.fullmatch(r"[\w.-]{1,64}", room):
                raise ValueError("invalid room")
            result = _shell("muc", "affiliations", f"{room}@conference.{domain}")
            response = {"returncode": result["returncode"], "output": result["stdout"][:12000]}
        elif action == "destroy_room":
            room = request["room"]
            if not isinstance(room, str) or not re.fullmatch(r"[\w.-]{1,64}", room):
                raise ValueError("invalid room")
            jid = f"{room}@conference.{domain}"
            result = _shell(f"muc:room({json.dumps(jid, ensure_ascii=False)}):destroy()")
            response = {"returncode": 0 if result["returncode"] == 0 and "Result: true" in result["stdout"] else 1,
                        "stderr": "room destruction failed" if result["returncode"] else ""}
        else:
            username = request["username"]
            if not isinstance(username, str) or (not re.fullmatch(r"[\w.-]{1,64}", username) or len(username.encode("utf-8")) > 64):
                raise ValueError("invalid username")
            if action == "credential_revision":
                response = {"returncode": 0, "revision": credential_revision(username, domain)}
            elif action == "register":
                password = request["password"]
                if not isinstance(password, str) or not 6 <= len(password) <= 256 or any(ord(c) < 32 or ord(c) == 127 for c in password):
                    raise ValueError("invalid password")
                result = subprocess.run(
                    [b"/usr/bin/prosodyctl", b"register", username.encode("utf-8"), domain.encode("utf-8"), password.encode("utf-8")],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, check=False,
                )
                response = {"returncode": result.returncode, "stdout": result.stdout[:2048], "stderr": result.stderr[:2048]}
            elif action == "change_password":
                password = request["password"]
                if not isinstance(password, str) or not 6 <= len(password) <= 256 or any(ord(c) < 32 or ord(c) == 127 for c in password):
                    raise ValueError("invalid password")
                result = subprocess.run(
                    [b"/usr/bin/prosodyctl", b"passwd", f"{username}@{domain}".encode("utf-8")],
                    input=f"{password}\n{password}\n", capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, check=False,
                )
                response = {"returncode": result.returncode, "stderr": "password update failed" if result.returncode else ""}
            elif action in ("disable_user", "enable_user", "delete_user"):
                command = {"disable_user": "disable", "enable_user": "enable", "delete_user": "delete"}[action]
                result = _shell("user", command, f"{username}@{domain}")
                response = {"returncode": 0 if result["returncode"] == 0 and "OK:" in result["stdout"] else 1,
                            "stderr": "user action failed" if result["returncode"] else ""}
            elif action == "end_sessions":
                result = _shell("c2s", "close", f"{username}@{domain}")
                response = {"returncode": 0 if result["returncode"] == 0 and "Error:" not in result["stdout"] else 1}
            else:
                raise ValueError("invalid action")
    except FileNotFoundError:
        response = {"returncode": 1, "stderr": "account unavailable"}
    except (KeyError, ValueError, TypeError, json.JSONDecodeError):
        response = {"returncode": 1, "stderr": "invalid registration request"}
    except subprocess.TimeoutExpired:
        response = {"returncode": 1, "stderr": "registration timed out"}
    conn.sendall((json.dumps(response) + "\n").encode())


def main() -> None:
    sock = socket.socket(fileno=3)
    while True:
        conn, _ = sock.accept()
        with conn:
            try:
                handle(conn)
            except (OSError, TimeoutError):
                pass


if __name__ == "__main__":
    main()
