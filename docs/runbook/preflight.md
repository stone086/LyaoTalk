# LyaoTalk 2.3.3 Preflight Hardening

Run this before any real staging install.

## 1. Generate or repair `.env`

```bash
bash scripts/env_wizard.sh
```

The wizard prompts for `DOMAIN` and `EMAIL`, then auto-generates missing secrets:

- `DB_PASS` / `POSTGRES_PASSWORD`
- `REDIS_PASS`
- `SECRET_KEY`
- `MINIO_ROOT_PASSWORD`
- `TURN_SECRET`
- `XMPP_ADMIN_PASS`
- temporary `ADMIN_PASS`, which `install.sh` hashes and removes from `.env`

Optional integrations are prompted only when enabled:

- OIDC requires issuer, client ID, and client secret.
- LDAP requires server URL, bind DN template, and user base.
- Prometheus external scraping can add `PROMETHEUS_ALLOW_CIDR`.

## 2. Validate `.env`

```bash
bash scripts/env_validate.sh --strict
```

This catches common install-breaking configuration errors before the installer starts:

- empty or placeholder `DOMAIN`
- `DOMAIN` accidentally written as `https://...`
- short or missing secrets
- OIDC/LDAP enabled without required fields
- metrics enabled without a protected nginx `/api/metrics` location

## 3. Host preflight

```bash
sudo bash scripts/preflight_check.sh --strict
```

This checks OS family, systemd, apt, disk, memory, DNS resolution, and key ports.

## 4. Configure-only mode

You can also run the installer only as a configuration wizard:

```bash
bash install.sh --configure
```

Then review `.env` and run the real install later.
