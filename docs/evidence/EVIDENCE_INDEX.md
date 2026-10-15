# LiaoT 2.3.2 Evidence Index

This release turns the unfinished roadmap items into concrete staging evidence workflows.

## Evidence folders

| Area | Evidence file | What must be attached after staging |
|---|---|---|
| Fresh install | `docs/evidence/install/staging-install-results.md` | `install.sh` output, post-install health, Stage 0, browser smoke |
| OMEMO interop | `docs/evidence/omemo/interop-results.md` | Conversations, Gajim, Dino test notes and screenshots/log excerpts |
| Python trusted build | `docs/evidence/trusted-build/python-hash-regeneration.md` | Ubuntu/Python-specific regenerated `requirements.txt` hash result |
| Monitoring | `docs/evidence/monitoring/prometheus-alertmanager-results.md` | Prometheus target health, alert rule check, sample `/api/metrics` output |
| Performance | `docs/evidence/performance/k6-baseline-results.md` | k6 p50/p95/error rate and server CPU/RAM/disk numbers |
| Browser compatibility | `docs/evidence/compatibility/browser-matrix-results.md` | Chrome/Edge/Firefox/Safari/iOS/Samsung real-device matrix |
| Ops drill | `docs/evidence/ops/backup-restore-drill-results.md` | Backup, restore, rollback, recovery timing |
| External audit | `docs/evidence/audit/external-audit-results.md` | Third-party audit or internal pentest report references |

## Release gate

Run:

```bash
bash scripts/evidence_gate_validate.sh --local
```

On staging, run:

```bash
sudo bash scripts/staging_evidence_collect.sh --domain staging.example.com
```

This release does not fake external evidence. If a real client, browser, Prometheus server, or auditor is required, the evidence file keeps the item marked as `PENDING` until the test is actually run.
