#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[FAIL] $*" >&2; exit 1; }
ok() { echo "[OK] $*"; }

[[ -f apps/api/app/core/logging.py ]] || fail "missing structured logging module"
[[ -f apps/api/app/core/observability.py ]] || fail "missing observability registry"
grep -q 'LOG_FORMAT' apps/api/app/core/config.py || fail "LOG_FORMAT setting missing"
grep -q 'METRICS_ENABLED' apps/api/app/core/config.py || fail "METRICS_ENABLED setting missing"
grep -q 'location = /api/metrics' configs/nginx/lyaotalk.conf || fail "nginx /api/metrics location missing"
grep -q 'lyaotalk_events_total' apps/api/app/core/observability.py || fail "event metric missing"
grep -q 'lyaotalk_http_requests_total' apps/api/app/core/observability.py || fail "http counter missing"
grep -q 'lyaotalk-alerts.yml' -R configs/prometheus docs/monitoring >/dev/null || fail "alert rules not documented"
python3 -m py_compile apps/api/app/core/logging.py apps/api/app/core/observability.py
python3 - <<'PY'
import sys
sys.path.insert(0, "apps/api")
from app.core.observability import MetricsRegistry
r = MetricsRegistry()
r.observe_http(method="GET", path="/api/health", status_code=200, elapsed_seconds=0.012)
r.inc("lyaotalk_events_total", event="admin_login_failed")
out = r.render_prometheus()
assert "lyaotalk_http_requests_total" in out
assert "lyaotalk_http_request_duration_seconds_bucket" in out
assert "lyaotalk_events_total" in out
print("[OK] metrics render smoke test")
PY
ok "observability static validation passed"
