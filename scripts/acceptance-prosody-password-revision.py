"""Verify the RC revision provider detects a direct prosodyctl password change."""
import importlib.util
import os
from pathlib import Path
import secrets
import subprocess


DOMAIN = "liaot.2-yc.com"
HELPER = Path(os.environ.get("LIAOT_HELPER_PATH", str(Path(__file__).resolve().parents[1] / "configs/prosody/liaot_registration_helper.py")))


def main() -> None:
    spec = importlib.util.spec_from_file_location("liaot_registration_helper", HELPER)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.DOMAIN = DOMAIN
    name = "versionaccept" + secrets.token_hex(4)
    jid = f"{name}@{DOMAIN}"
    old_password = secrets.token_urlsafe(20)
    new_password = secrets.token_urlsafe(20)
    try:
        subprocess.run(["prosodyctl", "register", name, DOMAIN, old_password], check=True, capture_output=True)
        before = helper.credential_revision(name, DOMAIN)
        changed = subprocess.run(
            ["prosodyctl", "passwd", jid],
            input=f"{new_password}\n{new_password}\n", text=True, capture_output=True,
        )
        if changed.returncode:
            raise RuntimeError("prosodyctl passwd failed")
        after = helper.credential_revision(name, DOMAIN)
        assert before != after, "credential revision did not change"
        print("PASS: direct prosodyctl passwd changed the credential revision")
    finally:
        subprocess.run(["prosodyctl", "deluser", jid], capture_output=True)


if __name__ == "__main__":
    main()
