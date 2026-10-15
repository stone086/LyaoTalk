# LiaoT staging validation runbook

Release: **1.6.3 stage0-validation**

Stage 0 is mandatory before OMEMO work, dependency hardening, or migration-heavy changes. The goal is to catch runtime bugs that static review cannot catch.

## 1. Prepare a clean VM

Recommended OS:

- Ubuntu 22.04 LTS
- Ubuntu 24.04 LTS

Use a real DNS name such as `staging.example.com` pointing to the VM. Do not use a fake domain for the final install pass, because nginx, certbot, Prosody and browser CSP behavior depend on real hostnames.

## 2. Run local/static validation before installation

From the project root:

```bash
bash scripts/stage0_validate.sh --local
```

This checks shell syntax, Python syntax, version consistency, unsafe `.env` sourcing, required roadmap files, and key hardening files.

## 3. Install on staging

```bash
sudo LIAOT_DOMAIN=staging.example.com bash install.sh
```

Save the full terminal output. If installation fails, do not continue to production. Fix and publish a new patch version.

## 4. Run server/runtime validation

```bash
sudo bash scripts/stage0_validate.sh --server --domain staging.example.com
```

The server mode checks:

- nginx config syntax
- Prosody config syntax
- service status for `liaot-api`, `prosody`, `nginx`, `minio`
- local and public health endpoints when available
- Alembic current/head/upgrade if `/opt/liaot/api/.venv/bin/alembic` exists
- recent API journal output

## 5. Manual browser validation

Open DevTools Console and run a complete session:

- admin login
- register one user
- send one text message
- upload one image
- create or join one group
- test SSO if configured
- install PWA on phone and test push notification

No CSP violation should appear during the full session.

## 6. Security scans

Python:

```bash
cd apps/api
.venv/bin/pip install pip-audit safety bandit
.venv/bin/pip-audit -r requirements.txt
.venv/bin/safety check -r requirements.txt
.venv/bin/bandit -r app/ -ll
```

Frontend:

```bash
cd apps/web
npm audit --production
npx --yes retire
```

Every HIGH/CRITICAL finding must be fixed or documented as a temporary exception before moving to Stage 1.

## 7. Release gate

Only move from v1.6.3 to v1.7.0 when all of these are true:

- `install.sh` completes on a clean VM.
- `nginx -t` passes.
- `prosodyctl check config` passes.
- `alembic upgrade head` passes.
- Browser flow passes.
- DevTools Console has no CSP violation.
- No unresolved HIGH/CRITICAL dependency finding remains.
