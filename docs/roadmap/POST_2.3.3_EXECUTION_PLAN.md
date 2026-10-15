# LiaoT post-2.3.3 execution plan

Baseline: `v2.3.4-prestaging-i18n-closure`

This document turns the post-2.3.3 ToDoList into two buckets:

1. **Done in this package** — items that can be completed before a real VPS run.
2. **Requires real staging evidence** — items that must be run on a clean VPS, real browsers, or third-party XMPP clients.

## Done in 2.3.4 before staging

- Added an i18n release gate for the English and Simplified Chinese language packs.
- Added missing UI translation keys found during static scan.
- Converted remaining obvious hardcoded UI text to i18n keys:
  - offline banner
  - AES-GCM media fallback text
  - link preview loading state
  - right-panel empty files state
  - group room visibility options
  - call hangup label
  - common remove/removed labels
- Added `scripts/i18n_validate.sh`.
- Added `apps/web/src/utils/i18n.test.ts`.
- Added `docs/i18n/I18N_COMPLETION.md`.
- Added `docs/release/2.3.4-validation-report.md`.

## Real-staging blockers before v2.4.0

Do not release `2.4.0 Staging Verified` until all items below have real evidence attached.

### A. Clean VPS install evidence

- Fresh Ubuntu 22.04 or 24.04 VPS.
- Real DNS records for `staging`, `turn`, and `conference`.
- `scripts/preflight_check.sh --strict` passes.
- `install.sh` completes.
- `scripts/stage0_validate.sh --server --domain <domain>` passes.
- Browser smoke test passes.
- Install logs saved under `docs/evidence/install/`.

### B. OMEMO interop evidence

- Conversations ↔ LiaoT.
- Gajim ↔ LiaoT.
- Dino ↔ LiaoT.
- Browser restart can still decrypt expected messages.
- Results saved in `docs/evidence/omemo/interop-results.md`.

### C. Performance evidence

- k6 baseline executed against staging.
- p50, p95, error rate, CPU peak, RAM peak recorded.
- Hot queries and unused indexes checked.
- Results saved in `docs/evidence/performance/k6-baseline-results.md`.

### D. Browser compatibility evidence

- Chrome / Edge / Firefox / Safari / iOS Safari minimum matrix.
- Safari private mode / IndexedDB / PWA push behavior checked.
- Results saved in `docs/evidence/compatibility/browser-matrix-results.md`.

### E. Monitoring evidence

- Prometheus target is UP.
- Alertmanager receives at least one test alert.
- Results saved in `docs/evidence/monitoring/prometheus-alertmanager-results.md`.

### F. Backup-restore evidence

- Staging has realistic seed data.
- Backup is produced and verified.
- Restore drill runs successfully on disposable staging data.
- Results saved in `docs/evidence/ops/backup-restore-drill-results.md`.

### G. Evidence gate

- `scripts/evidence_gate_validate.sh --local` must pass after evidence files are filled.

## Next release gates

- `2.4.0 — staging-verified`: all Workflow A evidence is filled and gate passes.
- `2.5.0 — omemo-validated`: OMEMO interop, Forward Secrecy, PreKey replenishment, key-change defense and device UX are validated.
- `3.0.0 — audited`: third-party audit or private bounty evidence is available and high/critical findings are closed.
