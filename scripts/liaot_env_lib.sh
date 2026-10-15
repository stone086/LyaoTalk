#!/usr/bin/env bash
# Shared .env helpers for LiaoT installer/preflight scripts.
set -euo pipefail

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

strip_quotes() {
  local value="${1:-}"
  value="${value%$'\r'}"
  value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

get_env_file_value() {
  local file="${1:-.env}"
  local key="${2:-}"
  local default="${3:-}"
  [[ -f "$file" ]] || { printf '%s' "$default"; return 0; }
  local line
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n1 || true)"
  [[ -n "$line" ]] || { printf '%s' "$default"; return 0; }
  strip_quotes "${line#*=}"
}

set_env_file_value() {
  local file="${1:-.env}"
  local key="${2:?key required}"
  local value="${3:-}"
  touch "$file"
  if grep -qE "^[[:space:]]*${key}=" "$file"; then
    python3 - "$file" "$key" "$value" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1]); key = sys.argv[2]; value = sys.argv[3]
lines = path.read_text().splitlines()
out=[]; replaced=False
for line in lines:
    if line.lstrip().startswith(key + "=") and not line.lstrip().startswith("#"):
        if not replaced:
            out.append(f"{key}={value}")
            replaced=True
        continue
    out.append(line)
if not replaced:
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

random_hex() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

random_urlsafe() {
  local bytes="${1:-32}"
  openssl rand -base64 "$bytes" | tr -d '\n=' | tr '+/' '-_' | cut -c1-$((bytes * 2))
}

valid_domain_name() {
  local d="${1:-}"
  [[ -n "$d" ]] || return 1
  [[ "$d" != http://* && "$d" != https://* ]] || return 1
  [[ "$d" != */* ]] || return 1
  [[ "$d" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] || return 1
  case "$d" in chat.example.com|chat.yourdomain.com|example.com|localhost) return 1 ;; esac
  return 0
}

valid_email() {
  local e="${1:-}"
  [[ "$e" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}
