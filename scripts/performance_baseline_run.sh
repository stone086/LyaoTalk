#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:-}"
OUT_DIR="docs/evidence/performance/runs/$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$BASE_URL" ]]; then
  echo "Set BASE_URL, for example: BASE_URL=https://staging.example.com bash scripts/performance_baseline_run.sh" >&2
  exit 2
fi
if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is required. Install it on staging before running this script." >&2
  exit 3
fi
mkdir -p "$OUT_DIR"
BASE_URL="$BASE_URL" k6 run --summary-export "$OUT_DIR/health-summary.json" examples/loadtest/health.js | tee "$OUT_DIR/health.log"
BASE_URL="$BASE_URL" k6 run --summary-export "$OUT_DIR/api-readiness-summary.json" examples/loadtest/api-readiness.js | tee "$OUT_DIR/api-readiness.log"
echo "Performance results written to $OUT_DIR"
