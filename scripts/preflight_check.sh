#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
STRICT=0

usage() {
  cat <<'USAGE'
Usage: sudo bash scripts/preflight_check.sh [--strict]

Checks host readiness before running install.sh:
  OS/systemd/apt, memory/disk, important ports, DNS, required commands, and .env.
USAGE
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

ok(){ echo "[OK] $*"; }
warn(){ echo "[WARN] $*"; }
fail(){ echo "[ERR] $*"; exit 1; }

[[ -f /etc/os-release ]] || fail "/etc/os-release not found"
# shellcheck disable=SC1091
source /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in *ubuntu*|*debian*) ok "Supported apt-based OS: ${PRETTY_NAME:-$ID}" ;; *) warn "Untested OS: ${PRETTY_NAME:-$ID}" ;; esac
command -v apt-get >/dev/null || fail "apt-get not found"
command -v systemctl >/dev/null || fail "systemctl not found"
for cmd in bash sed grep awk openssl python3 curl; do command -v "$cmd" >/dev/null || fail "required command missing: $cmd"; done

MEM_MB="$(free -m | awk '/^Mem:/{print $2}')"
(( MEM_MB >= 1500 )) && ok "Memory ${MEM_MB}MB" || warn "Memory ${MEM_MB}MB is below recommended 1500MB"
DISK_GB="$(df -BG "$ROOT_DIR" | awk 'NR==2{gsub(/G/,"",$4); print $4}')"
(( DISK_GB >= 10 )) && ok "Free disk ${DISK_GB}GB" || warn "Free disk ${DISK_GB}GB is below recommended 10GB"

if [[ -f "$ENV_FILE" ]]; then
  bash "${ROOT_DIR}/scripts/env_validate.sh" ${STRICT:+--strict} --env "$ENV_FILE"
  DOMAIN="$(bash -c "source '${ROOT_DIR}/scripts/lyaotalk_env_lib.sh'; get_env_file_value '${ENV_FILE}' DOMAIN ''")"
  if [[ -n "$DOMAIN" ]]; then
    if command -v getent >/dev/null && getent ahosts "$DOMAIN" >/dev/null; then
      ok "DNS resolves: $DOMAIN"
    else
      warn "DNS does not resolve locally yet: $DOMAIN"
    fi
  fi
else
  warn ".env not found. Run: bash scripts/env_wizard.sh"
fi

for port in 80 443 5222 5281 3478; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq ":${port}$"; then
    warn "TCP port ${port} is already listening; installer may conflict unless it is an existing LyaoTalk service"
  else
    ok "TCP port ${port} appears free"
  fi
done
ok "preflight completed"
