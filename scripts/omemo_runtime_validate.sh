#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/apps/web"

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

warn() {
  echo "[WARN] $*" >&2
}

ok() {
  echo "[OK] $*"
}

cd "$ROOT_DIR"

[[ -f docs/security/OMEMO_AUDIT.md ]] || fail "docs/security/OMEMO_AUDIT.md missing"
[[ -f docs/security/OMEMO_RUNTIME_VALIDATION.md ]] || fail "docs/security/OMEMO_RUNTIME_VALIDATION.md missing"
[[ -f docs/security/OMEMO_INTEROP_TEST_TEMPLATE.md ]] || fail "docs/security/OMEMO_INTEROP_TEST_TEMPLATE.md missing"
[[ -f apps/web/src/services/omemoTrust.ts ]] || fail "omemoTrust.ts missing"
[[ -f apps/web/src/services/omemoRuntimeValidation.ts ]] || fail "omemoRuntimeValidation.ts missing"
[[ -f apps/web/src/components/OmemoTrustView.tsx ]] || fail "OmemoTrustView.tsx missing"

grep -q 'keyChanged' apps/web/src/services/omemoTrust.ts || fail "keyChanged tracking not found in omemoTrust.ts"
grep -q 'indexedDB.open' apps/web/src/services/omemoTrust.ts || fail "IndexedDB trust storage not found"
grep -q 'shouldReplenishPreKeys' apps/web/src/services/omemoRuntimeValidation.ts || fail "prekey runtime helper missing"
grep -q 'Forward Secrecy' docs/security/OMEMO_RUNTIME_VALIDATION.md || fail "Forward Secrecy validation section missing"
grep -q 'Conversations' docs/security/OMEMO_INTEROP_TEST_TEMPLATE.md || fail "Conversations interop template missing"

ok "OMEMO runtime validation files are present"

if [[ -f "$WEB_DIR/package-lock.json" ]]; then
  ok "apps/web/package-lock.json present"
else
  fail "apps/web/package-lock.json missing"
fi

if command -v npm >/dev/null 2>&1; then
  cd "$WEB_DIR"
  if [[ -d node_modules ]]; then
    npm run build
    ok "web build passed; full test suite is covered by CI/web release gate"
  else
    warn "node_modules missing; run: cd apps/web && npm ci && npm run build && npm test"
  fi
else
  warn "npm not installed; skipping web build/test"
fi
