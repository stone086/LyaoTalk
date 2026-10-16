# LyaoTalk Install Runbook

Version: 2.2.0 ops-runbook

Use this runbook for a clean staging or production install. Do not skip staging for new releases.

## 1. Prerequisites

- Fresh Ubuntu 22.04 or 24.04 VM.
- DNS `A/AAAA` record already points to the server.
- Ports 80 and 443 are reachable from the internet.
- Root or sudo access.
- A release zip that has passed `scripts/stage0_validate.sh --local`.

## 2. Preflight

```bash
hostnamectl
ip addr
sudo ufw status verbose || true
getent hosts YOUR_DOMAIN
```

Confirm DNS resolves to this VM before running the installer.

## 3. Install

```bash
unzip lyaotalk-2.2.0-ops-runbook.zip
cd lyaotalk-2.2.0-ops-runbook
bash scripts/stage0_validate.sh --local
sudo LYAOTALK_DOMAIN=chat.example.com bash install.sh
```

Record the one-time admin password printed by the installer and store it in a password manager.

## 4. Immediate verification

```bash
sudo nginx -t
sudo prosodyctl check config
sudo systemctl status lyaotalk-api prosody nginx minio --no-pager
curl -fsS http://127.0.0.1:8000/health
curl -fsS https://chat.example.com/api/health
```

## 5. Functional smoke test

- Open `https://chat.example.com/`.
- Log in as admin.
- Create a test user.
- Log in as the test user.
- Send a text message.
- Upload a small image.
- Check browser DevTools for CSP violations.
- Check API logs for JSON request IDs.

## 6. Rollback criteria

Rollback immediately if any of the following occurs:

- API does not start.
- Alembic migrations fail.
- Nginx config fails.
- Prosody config fails.
- Login is broken for admin and normal user.
- Uploads fail because storage is unavailable.

See [upgrade.md](upgrade.md) and [backup-restore.md](backup-restore.md).
