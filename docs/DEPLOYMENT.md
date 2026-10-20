# Lyao Talk — independent build and VPS deployment

## Repository status

The `lyaotalk` names in service paths, database schemas and systemd service names remain for runtime compatibility. Production runs on rabisuB and is updated manually; there is no automatic production deploy. See the [live VPS runbook](runbook/live-vps.md) for its current layout and recovery steps.

## CI on every push / PR

`.github/workflows/ci.yml` checks shell scripts, frontend `npm ci`, tests, TypeScript/Vite build and npm high/critical audit; Python 3.12 hash-checked dependencies, tests and audit; CodeQL. Treat a green complete run as a minimum condition, not proof of real browser or OMEMO interoperability.

## Fresh install — isolated VPS only

Prerequisites: new Ubuntu/Debian machine reserved for Lyao Talk, DNS and HTTPS domain, backups, operator access. **Do not** run the installer on rabisuB: the installer provisions or configures system services, firewall, Prosody, database, Redis, MinIO and nginx. Use the update procedure in the [live VPS runbook](runbook/live-vps.md) for that host.

```bash
git clone https://github.com/stone086/LyaoTalk.git /opt/lyaotalk-bootstrap
cd /opt/lyaotalk-bootstrap
cp .env.example .env
# Edit .env and set unique DOMAIN / EMAIL and fresh secrets; never commit .env.
bash -n install.sh
sudo bash install.sh --repo https://github.com/stone086/LyaoTalk.git --domain chat.example.com --email you@example.com
```

The installer still uses `/opt/lyaotalk` and `/opt/lyaotalk-src` internally. It is not safe to run next to an existing installation without auditing and refactoring those paths first.

## Manual staging deploy (never automatic)

`.github/workflows/staging-deploy.yml` provides a `preflight` mode (default; no SSH) and an explicitly confirmed `deploy` mode. The deploy job uses GitHub environment `lyaotalk-staging`; configure **required reviewers** in its environment protection rules before putting in credentials. Configure environment secrets:

- `LYAOTALK_STAGING_HOST`: host of an isolated staging VPS, not the shared production host.
- `LYAOTALK_STAGING_USER`: restricted SSH operator with reviewed sudo permissions for `manage.sh`.
- `LYAOTALK_STAGING_SSH_KEY`: private SSH key stored only in GitHub secrets.
- `LYAOTALK_STAGING_HOST_KEY`: exact known_hosts line from independently verified host key, not an unchecked ssh-keyscan result.

On the isolated VPS, the operator must explicitly create `/etc/lyaotalk/isolated-staging-approved` after confirming the server is dedicated to this application. The remote repository must be `https://github.com/stone086/LyaoTalk.git`, checked out to `main` under `/opt/lyaotalk-src`.

The deploy workflow pins the initiating commit SHA, refuses a changed `origin/main`, and invokes `sudo bash manage.sh update`. That existing command does smoke checks, captures a snapshot, and attempts automatic application rollback; do not use the `--skip-snapshot` or `--no-rollback` bypass options. **A database restore and total service rollback are not guaranteed by an application snapshot**. Test them in isolation.

## Required acceptance before production cutover

1. CI green at the exact target commit.
2. New VPS installation and API health; HTTPS/WSS, login, direct chat, group chat and file download.
3. Per-account JWT revoke/password-change tests and private-file access controls.
4. Chrome/Firefox/Safari and reconnect/resume; OMEMO real-client interoperability.
5. PostgreSQL/Redis/Prosody/MinIO backups and isolated restore, version rollback rehearsal.
6. Record the release commit, backup, health checks and rollback decision before changing production.
