#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for f in \
  scripts/lyaotalk_env_lib.sh \
  scripts/env_wizard.sh \
  scripts/env_validate.sh \
  scripts/preflight_check.sh \
  docs/runbook/preflight.md; do
  [[ -f "$f" ]] || { echo "[ERR] missing $f" >&2; exit 1; }
done

bash -n scripts/lyaotalk_env_lib.sh
bash -n scripts/env_wizard.sh
bash -n scripts/env_validate.sh
bash -n scripts/preflight_check.sh
bash -n install.sh

TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"' EXIT
cp .env.example "$TMP_ENV"
python3 - "$TMP_ENV" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
repl={
'DOMAIN=chat.example.com':'DOMAIN=staging.52nbc.com',
'PUBLIC_DOMAIN=chat.example.com':'PUBLIC_DOMAIN=staging.52nbc.com',
'EMAIL=you@example.com':'EMAIL=admin@52nbc.com',
'XMPP_DOMAIN=chat.example.com':'XMPP_DOMAIN=staging.52nbc.com',
'DB_PASS=':'DB_PASS=0123456789abcdef0123456789abcdef',
'POSTGRES_PASSWORD=':'POSTGRES_PASSWORD=0123456789abcdef0123456789abcdef',
'REDIS_PASS=':'REDIS_PASS=0123456789abcdef0123456789abcdef',
'SECRET_KEY=':'SECRET_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
'XMPP_ADMIN_PASS=':'XMPP_ADMIN_PASS=0123456789abcdef01234567',
'TURN_SECRET=':'TURN_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
'MINIO_ROOT_PASSWORD=':'MINIO_ROOT_PASSWORD=0123456789abcdef01234567',
}
for a,b in repl.items():
    s=s.replace(a,b)
p.write_text(s)
PY
bash scripts/env_validate.sh --strict --env "$TMP_ENV"

BAD_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV" "$BAD_ENV"' EXIT
cp "$TMP_ENV" "$BAD_ENV"
sed -i 's|^DOMAIN=.*|DOMAIN=https://staging.52nbc.com|' "$BAD_ENV"
if bash scripts/env_validate.sh --strict --env "$BAD_ENV" >/tmp/lyaotalk-bad-env.out 2>&1; then
  echo "[ERR] env_validate accepted DOMAIN with https://" >&2
  cat /tmp/lyaotalk-bad-env.out >&2
  exit 1
fi

echo "[OK] preflight hardening validation passed"
