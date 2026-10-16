#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0
need_files=(
  docs/evidence/EVIDENCE_INDEX.md
  docs/evidence/install/staging-install-results.md
  docs/evidence/omemo/interop-results.md
  docs/evidence/trusted-build/python-hash-regeneration.md
  docs/evidence/monitoring/prometheus-alertmanager-results.md
  docs/evidence/performance/k6-baseline-results.md
  docs/evidence/compatibility/browser-matrix-results.md
  docs/evidence/ops/backup-restore-drill-results.md
  docs/evidence/audit/external-audit-results.md
  configs/prometheus/prometheus.yml.example
  configs/alertmanager/alertmanager.yml.example
  examples/observability/docker-compose.observability.yml
  scripts/staging_evidence_collect.sh
  scripts/performance_baseline_run.sh
  scripts/backup_restore_drill.sh
  scripts/regenerate_python_hashes.sh
)
for f in "${need_files[@]}"; do
  if [[ ! -f "$ROOT/$f" ]]; then
    echo "[FAIL] missing $f" >&2
    fail=1
  else
    echo "[OK] $f"
  fi
done
CURRENT_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || true)"
if [[ -z "$CURRENT_VERSION" ]]; then
  echo "[FAIL] VERSION is empty" >&2
  fail=1
else
  echo "[OK] VERSION=$CURRENT_VERSION"
fi
if grep -R -E "^[[:space:]]*source[[:space:]]+[^#]*(\.env|/\.env)" -n "$ROOT" --exclude-dir=.git --exclude='*.md' --exclude='*.txt' >/tmp/lyaotalk_source_env.$$ 2>/dev/null; then
  echo "[FAIL] unsafe env source pattern found:" >&2
  cat /tmp/lyaotalk_source_env.$$ >&2
  fail=1
fi
rm -f /tmp/lyaotalk_source_env.$$
if [[ $fail -ne 0 ]]; then exit 1; fi
echo "[OK] evidence gate files present"
