#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[FAIL] $*" >&2; exit 1; }
ok() { echo "[OK] $*"; }

[[ -f apps/web/src/services/browserCompatibility.ts ]] || fail "missing browser compatibility service"
[[ -f apps/web/src/services/browserCompatibility.test.ts ]] || fail "missing browser compatibility tests"
[[ -f docs/compatibility/COMPATIBILITY_CHAOS.md ]] || fail "missing compatibility chaos runbook"
[[ -f docs/compatibility/compatibility-chaos-results.md ]] || fail "missing compatibility evidence template"
[[ -f examples/chaos/manual-scenarios.md ]] || fail "missing manual chaos scenarios"

grep -q 'ios_push_requires_pwa' apps/web/src/services/browserCompatibility.ts || fail "iOS PWA push finding missing"
grep -q 'indexeddb_unavailable' apps/web/src/services/browserCompatibility.ts || fail "IndexedDB blocker missing"
grep -q 'webcrypto_unavailable' apps/web/src/services/browserCompatibility.ts || fail "WebCrypto blocker missing"
grep -q 'prosody.restart_during_session' apps/web/src/services/browserCompatibility.ts || fail "Prosody chaos scenario missing"
grep -q 'minio.unavailable_during_upload' apps/web/src/services/browserCompatibility.ts || fail "MinIO chaos scenario missing"
grep -q 'Token expires during upload' docs/compatibility/COMPATIBILITY_CHAOS.md || fail "token expiry recovery doc missing"

if [[ -d apps/web/node_modules ]]; then
  (cd apps/web && npx tsc --noEmit --pretty false >/tmp/liaot-compat-tsc.log 2>&1) || {
    cat /tmp/liaot-compat-tsc.log >&2
    fail "TypeScript check failed"
  }
  ok "TypeScript compatibility check passed"
else
  echo "[WARN] apps/web/node_modules missing; skipped TypeScript compatibility check"
fi

ok "compatibility chaos static validation passed"
