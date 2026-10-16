#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[FAIL] $*" >&2; exit 1; }
ok() { echo "[OK] $*"; }

required=(
  docs/runbook/ops-index.md
  docs/runbook/install.md
  docs/runbook/upgrade.md
  docs/runbook/backup-restore.md
  docs/runbook/incident-response.md
  docs/runbook/monitoring.md
  docs/runbook/secrets-rotation.md
  docs/runbook/disaster-recovery.md
)

for f in "${required[@]}"; do
  [[ -s "$f" ]] || fail "missing or empty $f"
done

# Check for operational keywords that matter during an incident.
grep -q "LYAOTALK_DOMAIN" docs/runbook/install.md || fail "install runbook missing LYAOTALK_DOMAIN install command"
grep -q "rollback" docs/runbook/upgrade.md || fail "upgrade runbook missing rollback procedure"
grep -q "pg_dump\|pg_restore" docs/runbook/backup-restore.md || fail "backup runbook missing database backup/restore commands"
grep -q "DELETE FROM refresh_tokens" docs/runbook/incident-response.md || fail "incident response missing refresh token revocation"
grep -q "lyaotalk_http_requests_total" docs/runbook/monitoring.md || fail "monitoring runbook missing Prometheus HTTP metric"
grep -q "SECRET_KEY" docs/runbook/secrets-rotation.md || fail "secrets rotation missing SECRET_KEY procedure"
grep -q "RPO" docs/runbook/disaster-recovery.md || fail "disaster recovery missing RPO/RTO targets"

current_version="$(tr -d '[:space:]' < VERSION)"
grep -q "\"version\": \"${current_version}\"" package.json || fail "root package.json version does not match VERSION"
grep -q "\"version\": \"${current_version}\"" apps/web/package.json || fail "web package.json version does not match VERSION"
grep -q "APP_VERSION=${current_version}" .env.example || fail ".env.example APP_VERSION does not match VERSION"

ok "ops runbook validation passed"
