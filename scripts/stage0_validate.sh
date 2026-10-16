#!/usr/bin/env bash
set -Eeuo pipefail

# Stage 0 validation helper for LyaoTalk.
# This script intentionally performs safe checks only. Server/runtime checks are
# optional and should be run on a clean staging VM after install.sh completes.

MODE="local"
DOMAIN=""
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
WARNINGS=0

usage() {
  cat <<USAGE
Usage:
  bash scripts/stage0_validate.sh --local
  sudo bash scripts/stage0_validate.sh --server --domain staging.example.com

Options:
  --local       Run static checks from the source tree. This is the default.
  --server      Run runtime checks on an installed staging server.
  --domain      Public staging domain used for HTTPS health checks.
  -h, --help    Show this help.
USAGE
}

pass() { printf '[PASS] %s\n' "$*"; }
warn() { WARNINGS=$((WARNINGS + 1)); printf '[WARN] %s\n' "$*" >&2; }
fail() { FAILURES=$((FAILURES + 1)); printf '[FAIL] %s\n' "$*" >&2; }
info() { printf '[INFO] %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE="local"; shift ;;
    --server) MODE="server"; shift ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

check_file() {
  local path="$1"
  [[ -f "$ROOT_DIR/$path" ]] && pass "Found $path" || fail "Missing $path"
}

check_shell_syntax() {
  local path="$1"
  if [[ -f "$ROOT_DIR/$path" ]]; then
    if bash -n "$ROOT_DIR/$path"; then
      pass "Shell syntax ok: $path"
    else
      fail "Shell syntax failed: $path"
    fi
  fi
}

check_no_unsafe_env_source() {
  local matches
  matches="$(grep -RInE '(^|[;[:space:]])source[[:space:]]+([^[:space:]]*/)?\.env(\>|[[:space:]]|$)|(^|[;[:space:]])\.[[:space:]]+([^[:space:]]*/)?\.env(\>|[[:space:]]|$)' "$ROOT_DIR" \
    --exclude-dir=.git --exclude='stage0_validate.sh' || true)"
  if [[ -z "$matches" ]]; then
    pass "No unsafe bare source .env pattern found"
  else
    fail "Unsafe .env sourcing found"
    printf '%s\n' "$matches" >&2
  fi
}

check_version_consistency() {
  local version package_version web_version env_version
  version="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION" 2>/dev/null || true)"
  package_version="$(python3 - <<PY 2>/dev/null || true
import json
print(json.load(open('$ROOT_DIR/package.json'))['version'])
PY
)"
  web_version="$(python3 - <<PY 2>/dev/null || true
import json
print(json.load(open('$ROOT_DIR/apps/web/package.json'))['version'])
PY
)"
  env_version="$(grep -E '^APP_VERSION=' "$ROOT_DIR/.env.example" | tail -n1 | cut -d= -f2- | tr -d '"' || true)"
  if [[ "$version" == "$package_version" && "$version" == "$web_version" && "$version" == "$env_version" ]]; then
    pass "Version metadata consistent: $version"
  else
    fail "Version mismatch: VERSION=$version package=$package_version web=$web_version env=$env_version"
  fi
}

check_env_labels() {
  if grep -q '^OIDC_LABEL="Single Sign-On"' "$ROOT_DIR/.env.example" && grep -q '^LDAP_LABEL="Corporate Login"' "$ROOT_DIR/.env.example"; then
    pass ".env.example quotes labels with spaces"
  else
    fail ".env.example label values with spaces are not safely quoted"
  fi
}

check_python_compile() {
  if command -v python3 >/dev/null 2>&1; then
    if python3 -m compileall -q "$ROOT_DIR/apps/api/app" "$ROOT_DIR/apps/api/alembic"; then
      pass "Python compileall ok for API and Alembic"
    else
      fail "Python compileall failed"
    fi
  else
    warn "python3 not found; skipped Python compile check"
  fi
}

check_required_hardening_files() {
  local files=(
    "apps/api/alembic/versions/0007_attach_object_key_idx.py"
    "apps/api/alembic/versions/0008_race_fix_and_perf_indexes.py"
    "apps/web/src/components/AesgcmMedia.tsx"
    "apps/web/src/services/aesgcmMedia.ts"
    "apps/web/src/services/connectionSupervisor.ts"
    "apps/web/src/utils/urlSafety.ts"
    "docs/roadmap/TODO.md"
    "docs/runbook/staging-validation.md"
  )
  local f
  for f in "${files[@]}"; do
    check_file "$f"
  done
}

check_lockfile_status() {
  if [[ -f "$ROOT_DIR/apps/web/package-lock.json" ]]; then
    pass "Frontend package-lock.json exists"
  else
    warn "apps/web/package-lock.json is missing; production frontend builds should provide a reviewed lockfile"
  fi
}

run_local_checks() {
  info "Running local/static Stage 0 checks in $ROOT_DIR"
  check_file "install.sh"
  check_file "manage.sh"
  check_file ".env.example"
  check_file "VERSION"
  check_shell_syntax "install.sh"
  check_shell_syntax "manage.sh"
  [[ -f "$ROOT_DIR/uninstall.sh" ]] && check_shell_syntax "uninstall.sh"
  check_no_unsafe_env_source
  check_version_consistency
  check_env_labels
  check_required_hardening_files
  check_python_compile
  check_lockfile_status
}

service_is_active() {
  local service="$1"
  if systemctl is-active --quiet "$service"; then
    pass "systemd active: $service"
  else
    fail "systemd not active: $service"
    systemctl status "$service" --no-pager -l || true
  fi
}

run_server_checks() {
  info "Running server/runtime Stage 0 checks"
  if [[ $EUID -ne 0 ]]; then
    warn "Server checks are best run as root via sudo"
  fi

  if command -v nginx >/dev/null 2>&1; then
    nginx -t && pass "nginx -t passed" || fail "nginx -t failed"
  else
    warn "nginx not found"
  fi

  if command -v prosodyctl >/dev/null 2>&1; then
    prosodyctl check config && pass "prosodyctl check config passed" || fail "prosodyctl check config failed"
  else
    warn "prosodyctl not found"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    service_is_active lyaotalk-api
    service_is_active prosody
    service_is_active nginx
    service_is_active minio
  else
    warn "systemctl not found"
  fi

  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 10 http://127.0.0.1:8000/health >/dev/null; then
      pass "Local API health ok: http://127.0.0.1:8000/health"
    elif curl -fsS --max-time 10 http://127.0.0.1:8000/api/health >/dev/null; then
      pass "Local API health ok: http://127.0.0.1:8000/api/health"
    else
      warn "Local API health endpoint did not respond on :8000"
    fi

    if [[ -n "$DOMAIN" ]]; then
      if curl -fsS --max-time 15 "https://${DOMAIN}/api/health" >/dev/null; then
        pass "Public HTTPS health ok: https://${DOMAIN}/api/health"
      else
        fail "Public HTTPS health failed: https://${DOMAIN}/api/health"
      fi
    else
      warn "No --domain provided; skipped public HTTPS health check"
    fi
  else
    warn "curl not found"
  fi

  local alembic_bin="/opt/lyaotalk/api/.venv/bin/alembic"
  if [[ -x "$alembic_bin" ]]; then
    (cd /opt/lyaotalk/api && sudo -u lyaotalk "$alembic_bin" current) && pass "alembic current passed" || fail "alembic current failed"
    (cd /opt/lyaotalk/api && sudo -u lyaotalk "$alembic_bin" heads) && pass "alembic heads passed" || fail "alembic heads failed"
    (cd /opt/lyaotalk/api && sudo -u lyaotalk "$alembic_bin" upgrade head) && pass "alembic upgrade head passed" || fail "alembic upgrade head failed"
  else
    warn "Alembic binary not found at $alembic_bin"
  fi

  if command -v journalctl >/dev/null 2>&1; then
    info "Recent lyaotalk-api journal lines:"
    journalctl -u lyaotalk-api --since "10 min ago" --no-pager -n 80 || true
  fi
}

case "$MODE" in
  local) run_local_checks ;;
  server) run_server_checks ;;
  *) fail "Invalid mode: $MODE" ;;
esac

if [[ "$FAILURES" -gt 0 ]]; then
  printf '\nStage 0 validation finished with %d failure(s) and %d warning(s).\n' "$FAILURES" "$WARNINGS" >&2
  exit 1
fi

printf '\nStage 0 validation passed with %d warning(s).\n' "$WARNINGS"
exit 0
