# Staging Fresh Install Results

Status: PASS_AFTER_HASH_LOCK_REPAIR

Target: `https://staging.example.com`

Run date: 2026-05-13

## Summary

`bash install.sh --run-local --ssh-port 22` completed on staging after repairing
the Python hash lock for Ubuntu 22.04 / CPython 3.10 wheels.

The first install attempt failed during backend dependency installation because
`apps/api/requirements.txt` was generated for CPython 3.13 Linux wheels while
staging uses Ubuntu 22.04 system Python 3.10. The repaired lock file was pulled
back into the repository as `apps/api/requirements.txt`.

## Install Evidence

```text
LiaoT Install Completed
Web URL:        https://staging.example.com
API Docs:       https://staging.example.com/api/docs
XMPP Domain:    staging.example.com
WebSocket:      wss://staging.example.com/xmpp-websocket
```

Installer stages completed:

```text
System checks passed
System dependencies installed
PostgreSQL 16 installed, database: liaot
Redis 7 installed
Prosody installed, domain: staging.example.com
MinIO installed, bucket: liaot-files
Node.js v20.20.2 already installed
FastAPI backend deployed, listening on 127.0.0.1:8000
Frontend build completed, output: /opt/liaot/web/dist
Nginx HTTPS configuration completed
Prosody TLS certificate configured
coturn installed
fail2ban configuration completed
Backup configured
Monitoring alert script configured
```

Non-interactive firewall prompts defaulted to no; UFW was not reset during the
SSH-based remote install.

## Post-Install Validation

```text
preflight_check.sh --strict
[OK] Supported apt-based OS: Ubuntu 22.04.5 LTS
[OK] Memory 3905MB
[OK] Free disk 57GB
[OK] env validation passed (0 warning(s))
[OK] DNS resolves: staging.example.com
[OK] preflight completed
```

```text
stage0_validate.sh --server --domain staging.example.com
[PASS] nginx -t passed
[PASS] prosodyctl check config passed
[PASS] systemd active: liaot-api
[PASS] systemd active: prosody
[PASS] systemd active: nginx
[PASS] systemd active: minio
[PASS] Local API health ok: http://127.0.0.1:8000/health
[PASS] Public HTTPS health ok: https://staging.example.com/api/health
[PASS] alembic current passed
[PASS] alembic heads passed
[PASS] alembic upgrade head passed
Stage 0 validation passed with 0 warning(s).
```

Browser smoke:

```text
status=200
title=LiaoT
hasLiaoT=true
hasLoginText=true
pageErrors=[]
screenshot=staging-browser-smoke.png
```

k6 low-concurrency smoke:

```text
health.js VUS=2 p95=5.27ms error_rate=0.00% PASS
api-readiness.js VUS=2 p95=5.3ms error_rate=0.00% PASS
```

Services after install:

```text
postgresql active
redis-server active
minio active
prosody active
coturn active
liaot-api active
nginx active
prometheus active
prometheus-alertmanager active
```

Prometheus target:

```text
job=liaot-api instance=127.0.0.1:8000 health=up
```
