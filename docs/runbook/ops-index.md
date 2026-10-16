# LyaoTalk Ops Runbook Index

Version: 2.2.0 ops-runbook

| Runbook | Purpose |
|---|---|
| [install.md](install.md) | clean server installation |
| [upgrade.md](upgrade.md) | release upgrade and rollback |
| [backup-restore.md](backup-restore.md) | backup verification and restore drill |
| [incident-response.md](incident-response.md) | security incident response |
| [monitoring.md](monitoring.md) | alert triage and metrics checks |
| [secrets-rotation.md](secrets-rotation.md) | scheduled and emergency secret rotation |
| [disaster-recovery.md](disaster-recovery.md) | full server rebuild from backup |
| [staging-validation.md](staging-validation.md) | pre-release staging validation |

## Release gate for ops readiness

```bash
bash scripts/ops_runbook_validate.sh
```

A release is not ops-ready unless the runbook validation passes and at least one staging restore drill has been recorded.
