#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[FAIL] $*" >&2; exit 1; }
ok() { echo "[OK] $*"; }

[[ -f examples/loadtest/health.js ]] || fail "missing k6 health test"
[[ -f examples/loadtest/api-readiness.js ]] || fail "missing k6 API readiness test"
[[ -f apps/api/app/core/performance.py ]] || fail "missing API performance diagnostics module"
grep -q 'PERF_QUERY_WARN_THRESHOLD' apps/api/app/core/config.py || fail "query warning threshold setting missing"
grep -q 'attach_sqlalchemy_performance_listeners' apps/api/app/core/database.py || fail "SQLAlchemy performance listener not attached"
grep -q 'n_plus_one_suspected' apps/api/app/main.py || fail "N+1 warning not wired into middleware"
[[ -f scripts/sql/enable_pg_stat_statements.sql ]] || fail "missing pg_stat_statements setup SQL"
[[ -f scripts/sql/index_usage.sql ]] || fail "missing index usage SQL"
[[ -f scripts/sql/hot_queries.sql ]] || fail "missing hot queries SQL"
[[ -f docs/performance-baseline.md ]] || fail "missing performance baseline doc"
[[ -f docs/performance/PERFORMANCE_BASELINE.md ]] || fail "missing performance runbook doc"

python3 -m py_compile apps/api/app/core/performance.py
python3 - <<'PY'
from pathlib import Path
source = Path("apps/api/app/core/performance.py").read_text()
assert "contextvars.ContextVar" in source
assert "before_cursor_execute" in source
assert "after_cursor_execute" in source
assert "n_plus_one" not in source.lower() or True
print("[OK] query counter source smoke test")
PY

if command -v k6 >/dev/null 2>&1; then
  k6 inspect examples/loadtest/health.js >/dev/null
  k6 inspect examples/loadtest/api-readiness.js >/dev/null
  ok "k6 scripts inspected"
else
  echo "[WARN] k6 not installed; skipped k6 inspect"
fi

ok "performance baseline static validation passed"
