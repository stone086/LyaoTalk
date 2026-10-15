#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---local}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[FAIL] $*" >&2; exit 1; }
pass() { echo "[OK] $*"; }
warn() { echo "[WARN] $*" >&2; }

[[ "$MODE" == "--local" || "$MODE" == "--ci" ]] || fail "usage: $0 [--local|--ci]"

[[ -f VERSION ]] || fail "VERSION missing"
PROJECT_VERSION="$(cat VERSION)"
[[ -n "$PROJECT_VERSION" ]] || fail "VERSION is empty"
pass "VERSION=$PROJECT_VERSION"

[[ -f apps/web/package-lock.json ]] || fail "apps/web/package-lock.json missing"
node -e "const fs=require('fs'); const v=fs.readFileSync('VERSION','utf8').trim(); const p=require('./apps/web/package.json'); const l=require('./apps/web/package-lock.json'); if(p.version!==v||l.version!==v) process.exit(1)" \
  || fail "web package.json/package-lock.json version mismatch"
pass "npm lockfile present and versioned"

if grep -R "npm install" -n install.sh manage.sh | grep -v "refusing" | grep -v "NEVER" | grep -v "never" >/dev/null; then
  fail "found unsafe npm install fallback in install/manage scripts"
fi
pass "no unsafe npm install fallback"

[[ -f apps/api/requirements.in ]] || fail "apps/api/requirements.in missing"
[[ -f apps/api/requirements.txt ]] || fail "apps/api/requirements.txt missing"
pass "Python requirements input and pinned output present"

if ! grep -q -- "--hash=sha256:" apps/api/requirements.txt; then
  fail "apps/api/requirements.txt is not hash-pinned"
fi
if ! grep -q -- "--require-hashes" install.sh; then
  fail "install.sh does not enforce pip --require-hashes"
fi
if ! grep -q -- "--require-hashes" manage.sh; then
  fail "manage.sh does not enforce pip --require-hashes"
fi
pass "Python requirements are hash-pinned and enforced"

if grep -nE "^[[:space:]]*source[[:space:]]+.*\.env" install.sh manage.sh scripts/*.sh 2>/dev/null; then
  fail "found direct env sourcing usage"
fi
pass "no direct env sourcing usage"

[[ -f docs/security/TRUSTED_BUILD.md ]] || fail "docs/security/TRUSTED_BUILD.md missing"
[[ -f "docs/release/${PROJECT_VERSION}-validation-report.md" ]] || warn "docs/release/${PROJECT_VERSION}-validation-report.md missing; release packaging should add it"
pass "trusted-build docs present"

bash -n install.sh
bash -n manage.sh
bash -n uninstall.sh
bash -n scripts/generate_sbom.sh
pass "shell syntax checks passed"

echo "Trusted-build local validation complete."
