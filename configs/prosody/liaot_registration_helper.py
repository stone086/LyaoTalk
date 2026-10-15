"""Narrow Prosody account registration service on a systemd Unix socket."""

import json
import os
import re
import socket
import stat
import subprocess
import hashlib


DOMAIN = os.environ.get("LIAOT_XMPP_DOMAIN", "")
DATA_ROOT = os.environ.get("LIAOT_PROSODY_DATA_ROOT", "/var/lib/prosody")


def _encoded_name(value: str) -> str:
    """Match Prosody internal storage's lowercase percent-encoded path names."""
    return "".join(char.lower() if char.isalnum() and char.isascii() else f"%{ord(char):02x}" for char in value.lower())


def credential_revision(username: str, domain: str) -> str:
    if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", username):
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
    while b"\n" not in data and len(data) <= 2048:
        chunk = conn.recv(1024)
        if not chunk:
            return
        data += chunk
    try:
        request = json.loads(data.split(b"\n", 1)[0])
        username = request["username"]
        domain = request["domain"]
        action = request.get("action", "register")
        if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", username):
            raise ValueError("invalid username")
        if domain != DOMAIN:
            raise ValueError("invalid domain")
        if action == "credential_revision":
            response = {"returncode": 0, "revision": credential_revision(username, domain)}
        elif action == "register":
            password = request["password"]
            if not isinstance(password, str) or not 6 <= len(password) <= 256 or any(ord(c) < 32 or ord(c) == 127 for c in password):
                raise ValueError("invalid password")
            result = subprocess.run(
                ["/usr/bin/prosodyctl", "register", username, domain, password],
                capture_output=True, text=True, timeout=15, check=False,
            )
            response = {"returncode": result.returncode, "stdout": result.stdout[:2048], "stderr": result.stderr[:2048]}
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
