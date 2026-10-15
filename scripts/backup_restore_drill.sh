#!/usr/bin/env bash
set -euo pipefail
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done
OUT="docs/evidence/ops/backup-restore-drill-$(date -u +%Y%m%dT%H%M%SZ).md"
mkdir -p "$(dirname "$OUT")"
{
  echo "# Backup Restore Drill Run"
  echo
  echo "- UTC: $(date -u +%FT%TZ)"
  echo "- dry_run: $DRY_RUN"
  echo
  echo "## Commands"
} > "$OUT"
record(){ echo "- $*" | tee -a "$OUT"; }
record "./manage.sh backup"
record "./manage.sh snapshot"
if [[ $DRY_RUN -eq 0 ]]; then
  echo "This script intentionally does not perform destructive restore automatically. Use docs/runbook/backup-restore.md on a disposable staging VM." | tee -a "$OUT"
else
  echo "Dry run only. No destructive command executed." | tee -a "$OUT"
fi
echo "Drill record written to $OUT"
