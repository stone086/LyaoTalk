#!/usr/bin/env bash
set -euo pipefail
DOMAIN=""
OUT_DIR="docs/evidence/staging-runs/$(date -u +%Y%m%dT%H%M%SZ)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2;;
    --out) OUT_DIR="${2:-}"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done
mkdir -p "$OUT_DIR"
log(){ echo "[$(date -u +%FT%TZ)] $*" | tee -a "$OUT_DIR/summary.log"; }
run(){ local name="$1"; shift; log "RUN $name: $*"; if "$@" >"$OUT_DIR/$name.out" 2>"$OUT_DIR/$name.err"; then log "OK $name"; else log "FAIL $name"; return 1; fi; }
log "LiaoT staging evidence collection"
run version cat VERSION || true
run stage0 bash scripts/stage0_validate.sh --local || true
run trusted_build bash scripts/trusted_build_validate.sh --local || true
run omemo_runtime bash scripts/omemo_runtime_validate.sh || true
run observability bash scripts/observability_validate.sh || true
run performance bash scripts/performance_validate.sh || true
run compatibility bash scripts/compatibility_chaos_validate.sh || true
run ops_runbook bash scripts/ops_runbook_validate.sh || true
run external_audit bash scripts/external_audit_validate.sh || true
run evidence_gate bash scripts/evidence_gate_validate.sh --local || true
if [[ -n "$DOMAIN" ]]; then
  log "Collecting live HTTP evidence for $DOMAIN"
  curl -fsS "https://$DOMAIN/api/health" >"$OUT_DIR/api-health.json" 2>"$OUT_DIR/api-health.err" || true
  curl -fsS "https://$DOMAIN/api/metrics" >"$OUT_DIR/api-metrics.txt" 2>"$OUT_DIR/api-metrics.err" || true
fi
cat >"$OUT_DIR/README.md" <<EOF
# Staging Evidence Run

- UTC time: $(date -u +%FT%TZ)
- Domain: ${DOMAIN:-not provided}
- Output: $OUT_DIR

Review all *.err files. A script failure is allowed only when the corresponding tool is not installed locally and the evidence doc keeps that item PENDING.
EOF
log "Evidence written to $OUT_DIR"
