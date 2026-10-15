#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail=0
info() { printf '[INFO] %s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
err() { printf '[ERR] %s\n' "$*"; fail=1; }

require_file() {
  local path="$1"
  [[ -s "$path" ]] && ok "$path" || err "Missing or empty: $path"
}

VERSION_EXPECTED="$(cat VERSION | tr -d '[:space:]')"

info "Validating external audit readiness artifacts"

require_file docs/security/THREAT_MODEL.md
require_file docs/audit/external-audit-brief.md
require_file docs/audit/pentest-scope.md
require_file docs/audit/bug-bounty-draft.md
require_file docs/audit/audit-evidence-checklist.md
require_file docs/audit/known-issues-register.md
require_file docs/audit/security-review-checklist.md
require_file "docs/release/${VERSION_EXPECTED}-validation-report.md"

for term in "STRIDE" "Trust boundaries" "Highest-risk areas"; do
  grep -q "$term" docs/security/THREAT_MODEL.md && ok "Threat model contains: $term" || err "Threat model missing: $term"
done

for term in "In-scope" "Out-of-scope" "Test accounts" "Reporting expectations"; do
  grep -q "$term" docs/audit/pentest-scope.md && ok "Pentest scope contains: $term" || err "Pentest scope missing: $term"
done

for term in "Safe harbor" "Severity guidance" "Prohibited actions"; do
  grep -q "$term" docs/audit/bug-bounty-draft.md && ok "Bug bounty draft contains: $term" || err "Bug bounty draft missing: $term"
done

ok "VERSION is ${VERSION_EXPECTED}"

if grep -q "APP_VERSION=${VERSION_EXPECTED}" .env.example; then
  ok ".env.example APP_VERSION is ${VERSION_EXPECTED}"
else
  err ".env.example APP_VERSION is not ${VERSION_EXPECTED}"
fi

if command -v python3 >/dev/null 2>&1; then
  VERSION_EXPECTED="$VERSION_EXPECTED" python3 - <<'PY'
import json, os
from pathlib import Path
expected = os.environ['VERSION_EXPECTED']
checks = [Path('package.json'), Path('apps/web/package.json'), Path('apps/web/package-lock.json')]
for p in checks:
    data = json.loads(p.read_text())
    if data.get('version') != expected:
        raise SystemExit(f'{p}: version {data.get("version")} != {expected}')
    if p.name == 'package-lock.json' and data.get('packages', {}).get('', {}).get('version') != expected:
        raise SystemExit(f'{p}: root package version mismatch')
print(f'[OK] package metadata version is {expected}')
PY
else
  err "python3 not available for JSON metadata check"
fi

if [[ $fail -ne 0 ]]; then
  printf '\nExternal audit readiness validation FAILED.\n' >&2
  exit 1
fi

printf '\nExternal audit readiness validation passed.\n'
