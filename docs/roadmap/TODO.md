# LiaoT Roadmap TODO

Base release: **1.6.2 merged hardening**  
Current release: **2.3.0 external-audit-ready**

This TODO turns the roadmap into release-sized work items. Each stage has a version target, deliverables, commands, and acceptance gates. Do not skip staging validation before encryption or destructive migrations.

## Version plan

| Stage | Target version | Release name | Goal | Status |
|---|---:|---|---|---|
| 0 | 1.6.3 | stage0-validation | Add staging validation scripts, runbooks, and release gates | Packaged |
| 1 | 1.7.0 | omemo-trust | OMEMO audit, fingerprint display, device trust, key-change warning | First pass packaged |
| 1.1 | 1.8.0 | trusted-build | Runtime validation helpers, tests, interop templates, release gate | Packaged |
| 2 | 1.8.1 | hash-pinned-python | Hash-pinned Python deps, npm lockfile, SBOM, CI CVE gates | Packaged |
| 3 | 1.9.0 | observability | JSON logs, Prometheus metrics, alert rules, audit anomaly checks | Packaged |
| 4 | 2.0.0 | performance-baseline | k6 load tests, N+1 query detection, DB index review | Packaged |
| 5 | 2.1.0 | compatibility-chaos | Browser matrix, Safari fallbacks, chaos/error-recovery tests | Packaged |
| 6 | 2.2.0 | ops-runbook | Install/upgrade/backup/incident/secrets/disaster docs | Packaged |
| 7 | 2.3.0 | external-audit-ready | Threat model, pentest prep, bug bounty checklist | Packaged |

## Stage 0 — v1.6.3 stage0-validation

Purpose: prove the installer and runtime can survive a clean staging deployment before touching OMEMO or migration-heavy features.

### Code/package deliverables

- [x] Add `scripts/stage0_validate.sh` for local/static and server/runtime checks.
- [x] Add `docs/runbook/staging-validation.md` with exact staging steps.
- [x] Add `docs/roadmap/TODO.md` to track staged releases.
- [x] Bump version metadata to `1.6.3`.
- [ ] Run on a clean Ubuntu 22.04/24.04 VM with a real DNS name.
- [ ] Save the validation report artifact from `scripts/stage0_validate.sh --server`.

### Acceptance gate

- [ ] `bash scripts/stage0_validate.sh --local` passes before upload.
- [ ] `sudo LIAOT_DOMAIN=staging.example.com bash install.sh` completes on a clean VM.
- [ ] `sudo scripts/stage0_validate.sh --server --domain staging.example.com` passes.
- [ ] Browser flow passes: admin login, user registration, text message, image upload, group join, PWA push.
- [ ] DevTools console has no CSP violation during a full session.
- [ ] No HIGH/CRITICAL findings from pip/npm/security scans, or every finding is documented with a temporary exception.

## Stage 1 — v1.7.0/v1.8.0 OMEMO trust and runtime validation

### TODO

- [x] Write `docs/security/OMEMO_AUDIT.md` answering: library, storage, session persistence, prekey lifecycle, XEP version, encrypted scope.
- [x] Implement IndexedDB-backed trust storage with localStorage compatibility.
- [x] Reuse existing identity fingerprint formatting and document remaining interop validation.
- [x] Add own-device fingerprint view.
- [x] Add peer device list with `Verify` and `Reject` actions.
- [x] Add key-change detection and warning.
- [x] Add PreKey low-watermark runtime helper and validation gate. Real staging test still required.
- [x] Add forward secrecy test procedure and result log template.
- [x] Add third-party interop test template for Conversations, Dino, and Gajim.
- [ ] Execute PreKey replenishment test on staging.
- [ ] Execute forward secrecy evidence collection on staging.
- [ ] Test interop with at least two of Conversations, Dino, and Gajim.

### Acceptance gate

- [x] `docs/security/OMEMO_AUDIT.md` is complete as an implementation audit; runtime results still pending.
- [ ] Trust state survives browser restart. IndexedDB storage implemented; browser restart test still required.
- [ ] Key-change warning appears in trust UI. Send-time blocking/warning still needs integration before sensitive sending.
- [x] Forward secrecy test procedure is documented.
- [ ] Forward secrecy test result is documented after staging execution.
- [ ] At least two third-party client interop tests pass.

## Stage 2 — v1.8.1 hash-pinned-python

### TODO

- [ ] Convert Python requirements to hash-pinned requirements.
- [ ] Require `pip install --require-hashes` in install/build paths.
- [ ] Add/review `apps/web/package-lock.json`.
- [ ] Use `npm ci --audit-level=high` in CI.
- [ ] Generate Python and Node SBOM artifacts.
- [ ] Add CI gates for `pip-audit`, `npm audit`, and `bandit`.

## Stage 3 — v1.9.0 observability

### TODO

- [ ] Introduce structured JSON logs.
- [ ] Add request ID propagation.
- [ ] Expose Prometheus `/metrics` behind restricted nginx location.
- [ ] Add alert examples for 5xx, login failures, CSP violations, 429 spikes, disk usage, and certificate expiry.
- [ ] Add audit-log anomaly query scripts.

## Stage 4 — v2.0.0 performance-baseline

### TODO

- [x] Add k6 smoke/load tests.
- [x] Add staging-safe SQL query counter / N+1 warning.
- [x] Add pg_stat_statements setup notes and SQL scripts.
- [x] Write `docs/performance-baseline.md` template.
- [x] Add `docs/performance/PERFORMANCE_BASELINE.md` runbook.
- [ ] Fill measured staging numbers in `docs/performance-baseline.md`.
- [ ] Remediate any repeated N+1 warnings on core chat routes.

## Stage 5 — v2.1.0 compatibility-chaos

### TODO

- [ ] Test Chrome/Edge, Firefox, Safari, iOS PWA, Android PWA.
- [ ] Add Safari IndexedDB/private-mode fallback warning.
- [ ] Test upload/token refresh/Prosody restart/MinIO outage recovery paths.
- [ ] Document browser-specific limitations.

## Stage 6 — v2.2.0 ops-runbook

### TODO

- [x] Finish `docs/runbook/install.md`.
- [x] Finish `docs/runbook/upgrade.md`.
- [x] Finish `docs/runbook/backup-restore.md`.
- [x] Finish `docs/runbook/incident-response.md`.
- [x] Finish `docs/runbook/monitoring.md`.
- [x] Finish `docs/runbook/secrets-rotation.md`.
- [x] Finish `docs/runbook/disaster-recovery.md`.
- [ ] Run a monthly backup restore drill on staging and record the result.

## Stage 7 — v2.3.0 external-audit-ready

### TODO

- [ ] Write threat model.
- [ ] Prepare OMEMO/security audit package.
- [ ] Prepare pentest scope.
- [ ] Prepare private bug bounty policy.


## Stage 2 — v1.8.1 Hash-pinned Python

- [x] Add local trusted-build validator.
- [x] Require npm lockfile presence.
- [x] Add SBOM generation script.
- [x] Add CI workflow for audits and build checks.
- [ ] Generate hash-pinned Python requirements on an online trusted builder.
