# LiaoT 1.6.3 stage0-validation package

Base package: `liaot-1.6.2-merged-hardening.zip`.

This release starts the roadmap execution by adding the Stage 0 validation toolkit. It keeps the v1.6.2 merged hardening base and adds a concrete TODO/version plan plus staging validation scripts.

## Version

- Release version: `1.6.3`
- Release name: `stage0-validation`

## Added

- `docs/roadmap/TODO.md` — staged roadmap with version numbers and acceptance gates.
- `docs/runbook/staging-validation.md` — clean VM staging validation runbook.
- `scripts/stage0_validate.sh` — local/static and server/runtime validation helper.

## Preserved from v1.6.2

- Native-safe `.env` parsing fixes.
- OIDC verification hardening.
- Audit IP hardening.
- Nginx hardening.
- AES-GCM media support.
- URL safety filtering.
- XMPP reconnect supervision.
- Alembic migrations 0007/0008.
- Refresh-token improvements.
- Snapshot/rollback tooling.

## Important limitation

This package has been statically validated in the build environment. It still must be installed on a clean staging VM and validated with:

```bash
bash scripts/stage0_validate.sh --local
sudo LIAOT_DOMAIN=staging.example.com bash install.sh
sudo bash scripts/stage0_validate.sh --server --domain staging.example.com
```

## 1.6.4 Frontend Closure

- Treats `liaot-1.6.3-stage0-validation` as the new development base.
- Fixes the LoginPage REST token fallback so `/api/auth/user-token` 401 no longer blocks a successful XMPP login.
- Fixes DiscoveryPage and RightPanel TypeScript regressions.
- Adds `apps/web/package-lock.json` and verifies `npm run build`.
- Updates axios and npm transitive overrides so the production npm audit has no high vulnerabilities.


## 1.8.0 OMEMO Runtime Validation

- Uses `1.7.0` as the feature base.
- Adds Stage 1 validation utilities, docs, and tests.
- Does not change the server deployment contract.
- Keeps the explicit limitation that third-party OMEMO interop and Forward Secrecy require staging/device validation.

## 1.8.1 Hash-Pinned Python

This release continues from 1.7.1 and starts roadmap Stage 2. It adds trusted-build release gates, CI security checks, SBOM generation hooks, and explicit dependency-locking policy while preserving the 1.7.x OMEMO runtime validation work.


## 1.9.0 Observability

This release adds structured JSON logs, a Prometheus-compatible metrics endpoint, nginx protection for `/api/metrics`, basic alert rules, and a local/CI validation script.


## 2.0.0 Performance Baseline

- Continued from `1.9.0-observability`.
- Added k6 load-test examples, SQL query-count diagnostics, PostgreSQL review scripts, and performance baseline runbooks.
- No new Python runtime dependency was added, preserving hash-pinned Python install behavior from 1.8.1.

## 2.1.0 Compatibility Chaos

- Continued from `2.0.0-performance-baseline`.
- Added browser compatibility diagnostics and chaos recovery evidence templates.
- Added Safari/iOS PWA notes, IndexedDB/WebCrypto blockers, and manual staging scenarios.

## 2.2.0 Ops Runbook

- Continued from `2.1.0-compatibility-chaos`.
- Added operational runbooks for install, upgrade, backup/restore, incident response, monitoring, secret rotation, and disaster recovery.
- Added `scripts/ops_runbook_validate.sh` and CI validation for ops readiness.


## 2.3.0 External Audit Ready

- Continued from `2.2.0-ops-runbook`.
- Added threat modeling, third-party audit handoff materials, penetration-test scope, bug bounty draft, and audit evidence checklist.
- Added `scripts/external_audit_validate.sh` and CI validation for external-audit readiness.
- This package is audit-preparation material; it does not represent a completed third-party audit.


## 2.3.3 Staging Evidence Kit

Adds concrete scripts and evidence files to operationalize the remaining roadmap gates. Real external evidence is intentionally left PENDING until run on staging or by third-party tools.
