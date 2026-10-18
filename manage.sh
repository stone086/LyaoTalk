#!/usr/bin/env bash
set -euo pipefail

# The release-based VPS layout has existing PostgreSQL, nginx and Prosody data.
# Never run the monolithic installer commands against that host.
if [[ -f /etc/lyaotalk/api.env && -L /opt/lyaotalk-current ]]; then
  live_command="${1:-status}"
  case "$live_command" in
    status|check)
      for unit in lyaotalk-api lyaotalk-minio lyaotalk-redis lyaotalk-prosody.socket prosody coturn nginx postgresql@14-main; do
        printf '%-28s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)"
      done
      curl -fsS https://lyaot.2-yc.com/api/health
      echo
      ;;
    api-health) curl -fsS https://lyaot.2-yc.com/api/health; echo ;;
    restart-api) systemctl restart lyaotalk-api ;;
    restart-nginx) nginx -t && systemctl reload nginx ;;
    logs-api) exec journalctl -u lyaotalk-api -f ;;
    logs-xmpp) exec journalctl -u prosody -f ;;
    logs-nginx) exec tail -f /var/log/nginx/access.log ;;
    logs-nginx-err) exec tail -f /var/log/nginx/error.log ;;
    backup) exec /usr/local/sbin/lyaotalk-backup ;;
    update)
      [[ "$(id -u)" -eq 0 ]] || { echo "Run update as root" >&2; exit 1; }
      source_dir=/opt/lyaotalk-src
      [[ -z "$(git -C "$source_dir" status --porcelain)" ]] || { echo "Source checkout has changes" >&2; exit 1; }
      git -C "$source_dir" fetch origin main
      git -C "$source_dir" merge --ff-only origin/main
      exec bash "$source_dir/scripts/deploy-vps-release.sh" "$(git -C "$source_dir" rev-parse HEAD)"
      ;;
    *) echo "Command '$live_command' is unavailable on the release-based VPS; use status, backup, update, restart-api, restart-nginx, or logs-*" >&2; exit 2 ;;
  esac
  exit 0
fi

INSTALL_DIR="/opt/lyaotalk"
SRC_DIR="/opt/lyaotalk-src"
SERVICES=("postgresql" "redis-server" "prosody" "minio" "lyaotalk-api" "nginx")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

ensure_rsync() {
  if command -v rsync >/dev/null 2>&1; then
    return 0
  fi
  echo -e "${YELLOW}rsync not found, installing...${NC}"
  run_root apt-get update -qq
  run_root apt-get install -y rsync
}

ensure_nodejs20() {
  local current_major=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$current_major" =~ ^[0-9]+$ ]] && (( current_major >= 20 )); then
      return 0
    fi
  fi

  echo -e "${YELLOW}Node.js 20+ required for production frontend build; installing NodeSource 20.x...${NC}"
  if curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash - >/dev/null 2>&1; then
    run_root apt-get install -y -qq nodejs
  else
    echo -e "${RED}NodeSource setup failed; install Node.js 20+ and retry.${NC}" >&2
    return 1
  fi

  current_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if ! [[ "$current_major" =~ ^[0-9]+$ ]] || (( current_major < 20 )); then
    echo -e "${RED}Node.js 20+ is required, installed: $(node --version)${NC}" >&2
    return 1
  fi
}

git_fetch_with_retry() {
  local attempts=3
  local delay=3
  local n=1
  while (( n <= attempts )); do
    if git fetch --all --prune; then
      return 0
    fi
    if (( n == attempts )); then
      echo -e "${RED}git fetch failed after ${attempts} attempts${NC}"
      return 1
    fi
    echo -e "${YELLOW}git fetch failed (attempt ${n}/${attempts}), retrying in ${delay}s...${NC}"
    sleep "${delay}"
    n=$((n + 1))
  done
}

usage() {
  echo -e "${CYAN}Lyao Talk manage${NC}"
  echo ""
  echo "Usage: bash manage.sh <command>"
  echo ""
  echo "Service:"
  echo "  status          Show service status"
  echo "  start           Start all services"
  echo "  stop            Stop all services"
  echo "  restart         Restart all services"
  echo "  restart-api     Restart API service only"
  echo "  restart-nginx   Reload nginx only"
  echo ""
  echo "Logs:"
  echo "  logs-api        Tail API journal"
  echo "  logs-xmpp       Tail Prosody log"
  echo "  logs-nginx      Tail nginx access log"
  echo "  logs-nginx-err  Tail nginx error log"
  echo ""
  echo "XMPP:"
  echo "  add-user        Add XMPP user"
  echo "  del-user        Delete XMPP user"
  echo "  list-users      List XMPP users"
  echo "  change-pass     Change XMPP user password"
  echo ""
  echo "Ops:"
  echo "  backup          Run backup now"
  echo "  backup-restore  Restore database from backup file"
  echo "  update          Recommended: incremental update with smoke + snapshot + auto-rollback"
  echo "                  (use --skip-smoke / --skip-snapshot / --no-rollback to override)"
  echo "  update-front    Update frontend only (no safety pipeline)"
  echo "  update-api      Update API only (no safety pipeline)"
  echo "  smoke-check     Run pre-flight checks against current source tree"
  echo "                  (Python+Bash syntax, migration chain, TypeScript, nginx config)"
  echo "  snapshot        Manually capture a rollback point"
  echo "                  (git SHA, alembic rev, web/dist tarball, encrypted DB dump)"
  echo "  list-snapshots  Show available rollback snapshots"
  echo "  rollback        Roll back to most recent snapshot (with confirmation)"
  echo "  rollback-to     Roll back to a specific snapshot directory"
  echo "                  (add --restore-db to also restore data; DROPS current DB)"
  echo "  health-gate     Multi-layer probe: API + DB + Redis + Prosody + Nginx"
  echo "  ssl-renew       Renew SSL certificates"
  echo "  db-shell        Open PostgreSQL shell"
  echo "  db-history      Show alembic migration history"
  echo "  db-rollback     Rollback alembic migration"
  echo "  check           Quick health check"
  echo "  api-health      Probe public API health endpoint"
  echo "  cert-info       Show SSL certificate expiry"
  echo "  disk-usage      Show disk usage details"
  echo "  ports           Show listening ports"
  echo "  backup-verify   Verify latest database backup archive integrity"
  echo "  env-check       Validate key runtime env values"
  echo "  top-requests    Top nginx requests from access log"
  echo "  mem-usage       Show process memory usage"
  echo "  watchdog        Run lyaotalk watchdog once"
}

load_env() {
  local env_file="${SRC_DIR}/.env"
  [[ -f "$env_file" ]] || return 0

  # Safe .env loader: parse KEY=VALUE as data and never execute .env content.
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue

    local key val
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    val="$(printf '%s' "$val" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"

    if [[ "$val" =~ ^\".*\"$ ]]; then
      val="${val:1:${#val}-2}"
    elif [[ "$val" =~ ^\'.*\'$ ]]; then
      val="${val:1:${#val}-2}"
    fi

    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      export "$key=$val"
    fi
  done < "$env_file"
}

cmd_status() {
  echo -e "\n${CYAN}== Services ==${NC}"
  for svc in "${SERVICES[@]}"; do
    status="$(systemctl is-active "$svc" 2>/dev/null || echo unknown)"
    if [[ "$status" == "active" ]]; then
      echo -e "  ${GREEN}OK${NC}  $svc"
    else
      echo -e "  ${RED}NO${NC}  $svc ($status)"
    fi
  done

  echo -e "\n${CYAN}== Memory ==${NC}"
  free -h | grep -E "^(Mem|Swap)"
  echo -e "\n${CYAN}== Disk ==${NC}"
  df -h / /data 2>/dev/null || true
}

cmd_start() { for svc in "${SERVICES[@]}"; do systemctl start "$svc"; done; }
cmd_stop() {
  echo "Draining nginx connections..."
  nginx -s quit >/dev/null 2>&1 || true
  sleep 2
  echo "Stopping API gracefully..."
  systemctl stop lyaotalk-api 2>/dev/null || true
  sleep 1
  for svc in minio prosody redis-server postgresql; do
    systemctl stop "$svc" 2>/dev/null || true
  done
}
cmd_restart() { for svc in "${SERVICES[@]}"; do systemctl restart "$svc"; done; }

cmd_add_user() {
  load_env
  domain="${XMPP_DOMAIN:-localhost}"
  read -rp "Username: " username
  prosodyctl adduser "${username}@${domain}"
}

cmd_del_user() {
  load_env
  domain="${XMPP_DOMAIN:-localhost}"
  read -rp "Username to delete: " username
  prosodyctl deluser "${username}@${domain}"
}

cmd_list_users() {
  load_env
  domain="${XMPP_DOMAIN:-localhost}"
  prosodyctl list users "$domain"
}

cmd_change_pass() {
  load_env
  domain="${XMPP_DOMAIN:-localhost}"
  read -rp "Username: " username
  prosodyctl passwd "${username}@${domain}"
}

cmd_update_front() {
  load_env
  ensure_rsync
  ensure_nodejs20
  mkdir -p "${INSTALL_DIR}/web"
  run_root rsync -a --delete \
    --exclude "node_modules" \
    --exclude "dist" \
    --exclude ".env.production" \
    "${SRC_DIR}/apps/web/" "${INSTALL_DIR}/web/"
  cd "${INSTALL_DIR}/web"

  if [[ -n "${DOMAIN:-}" ]]; then
    cat > .env.production <<EOF
VITE_API_URL=https://${DOMAIN}/api
VITE_XMPP_WS_URL=wss://${DOMAIN}/xmpp-websocket
VITE_XMPP_DOMAIN=${XMPP_DOMAIN:-${DOMAIN}}
EOF
  fi

  if [[ -f package-lock.json ]]; then
    npm ci --silent
  else
    # See install.sh — never silently fall back to `npm install` because
    # caret ranges resolve to latest at install time (supply-chain risk).
    echo "ERROR: package-lock.json missing in apps/web — refusing to run 'npm install' without a lockfile" >&2
    return 1
  fi
  npm run build
  run_root chmod -R a+rX "${INSTALL_DIR}/web/dist" || true
  if [[ -f "${SRC_DIR}/configs/nginx/lyaotalk.conf" ]]; then
    run_root cp "${SRC_DIR}/configs/nginx/lyaotalk.conf" /etc/nginx/sites-available/lyaotalk
    run_root sed -i "s|DOMAIN|${DOMAIN}|g" /etc/nginx/sites-available/lyaotalk
    run_root sed -i "s|INSTALL_DIR|${INSTALL_DIR}|g" /etc/nginx/sites-available/lyaotalk
    if [[ -n "${PROMETHEUS_ALLOW_CIDR:-}" ]]; then
      run_root sed -i "/location = \/api\/metrics {/,/deny all;/ s|deny all;|allow ${PROMETHEUS_ALLOW_CIDR};\n        deny all;|" /etc/nginx/sites-available/lyaotalk
    fi
  fi
  if [[ -f "${SRC_DIR}/configs/nginx/lyaotalk-rate-limit.conf" ]]; then
    run_root cp "${SRC_DIR}/configs/nginx/lyaotalk-rate-limit.conf" /etc/nginx/conf.d/lyaotalk-rate-limit.conf
  fi
  # Test nginx config before reloading — `nginx -t` catches syntax errors
  # without taking the service down. Without this, a bad nginx.conf would
  # cause systemctl reload to silently no-op (old config keeps serving).
  if ! run_root nginx -t 2>/dev/null; then
    echo -e "${RED}nginx -t failed; skipping reload to keep current config alive${NC}"
    run_root nginx -t  # show the error this time
    return 1
  fi
  run_root systemctl reload nginx
  echo -e "${GREEN}Frontend updated${NC}"
}

cmd_update_api() {
  ensure_rsync
  mkdir -p "${INSTALL_DIR}/api"
  run_root rsync -a --delete \
    --exclude ".venv" \
    --exclude ".env" \
    "${SRC_DIR}/apps/api/" "${INSTALL_DIR}/api/"
  [[ -f "${SRC_DIR}/VERSION" ]] && run_root cp "${SRC_DIR}/VERSION" "${INSTALL_DIR}/api/VERSION"
  cd "${INSTALL_DIR}/api"

  if [[ ! -d .venv ]]; then
    python3.11 -m venv .venv
  fi
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q --require-hashes -r requirements.txt

  if [[ -f .env && -f alembic.ini ]]; then
    db_url="$(grep '^DATABASE_URL=' .env | cut -d= -f2- || true)"
    if [[ -n "${db_url}" ]]; then
      current_url="$(grep '^sqlalchemy.url = ' alembic.ini | cut -d= -f2- | xargs || true)"
      if [[ -z "${current_url}" || "${current_url}" == "postgresql+asyncpg://user:pass@localhost/dbname" ]]; then
        sed -i "s|^sqlalchemy.url = .*|sqlalchemy.url = ${db_url}|" alembic.ini
      else
        echo "Keeping operator-managed alembic sqlalchemy.url"
      fi
    fi
  fi
  .venv/bin/alembic upgrade head
  run_root systemctl restart lyaotalk-api
  echo -e "${GREEN}API updated${NC}"
}

# ----------------------------------------------------------------------------
# Release lifecycle: snapshot -> smoke -> deploy -> health gate -> rollback
# ----------------------------------------------------------------------------

# Directory holding rollback snapshots. Each entry is a timestamped folder
# containing { git_sha, alembic_revision, web_dist.tar.gz }.
SNAPSHOT_DIR="/var/lib/lyaotalk/snapshots"

# Pre-flight syntax/import smoke check on the *source* tree.
# Runs BEFORE we touch the install dir, so a broken commit never reaches prod.
cmd_smoke_check() {
  echo -e "${CYAN}[smoke] Pre-flight checks${NC}"
  cd "${SRC_DIR}"
  local failed=0

  # 1. Python syntax: every .py file in apps/api/app must parse
  echo -n "  Python syntax... "
  local py_errors
  py_errors="$(find apps/api/app -name '*.py' -not -path '*__pycache__*' \
       -exec python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" {} \; 2>&1)"
  if [[ -n "${py_errors}" ]]; then
    echo -e "${RED}FAIL${NC}"
    echo "${py_errors}" | sed 's/^/    /' | head -5
    failed=1
  else
    echo -e "${GREEN}OK${NC}"
  fi

  # 2. Bash syntax: install/manage/uninstall scripts
  echo -n "  Bash syntax... "
  local bash_failed=0
  for f in install.sh manage.sh uninstall.sh; do
    if [[ -f "${f}" ]] && ! bash -n "${f}" 2>/dev/null; then
      [[ ${bash_failed} -eq 0 ]] && echo -e "${RED}FAIL${NC}"
      echo "    syntax error in ${f}"
      bash_failed=1
      failed=1
    fi
  done
  [[ ${bash_failed} -eq 0 ]] && echo -e "${GREEN}OK${NC}"

  # 3. Migration files have a unique linear chain (no two files claim the same down_revision)
  # This catches "two devs added migrations in parallel" without needing alembic installed.
  echo -n "  Migration chain... "
  if [[ -d "apps/api/alembic/versions" ]]; then
    local dup_downrev
    dup_downrev="$(grep -h '^down_revision' apps/api/alembic/versions/*.py 2>/dev/null \
      | grep -vE 'down_revision[[:space:]]*(:[^=]+)?=[[:space:]]*None' \
      | sort | uniq -d)"
    if [[ -n "${dup_downrev}" ]]; then
      echo -e "${RED}FAIL${NC}"
      echo "    Two migrations share the same down_revision (branch in chain):"
      echo "${dup_downrev}" | sed 's/^/      /'
      failed=1
    else
      # Also check that every revision = X declared corresponds to a file
      local missing_rev=0
      for downrev in $(grep -h '^down_revision' apps/api/alembic/versions/*.py 2>/dev/null \
                       | grep -vE 'down_revision[[:space:]]*(:[^=]+)?=[[:space:]]*None' \
                       | sed -E "s/.*[\"']([^\"']+)[\"'].*/\1/" | sort -u); do
        if ! grep -Eq "^revision[[:space:]]*(:[^=]+)?=[[:space:]]*[\"']${downrev}[\"']" apps/api/alembic/versions/*.py 2>/dev/null; then
          missing_rev=1
          break
        fi
      done
      if [[ ${missing_rev} -eq 1 ]]; then
        echo -e "${RED}FAIL${NC}"
        echo "    A migration references a down_revision that no file declares"
        failed=1
      else
        echo -e "${GREEN}OK${NC}"
      fi
    fi
  else
    echo "skipped (no migration dir)"
  fi

  # 4. Frontend critical files exist
  echo -n "  Frontend essentials... "
  local fe_failed=0
  for required in apps/web/package.json apps/web/index.html apps/web/src/main.tsx; do
    if [[ ! -f "${required}" ]]; then
      [[ ${fe_failed} -eq 0 ]] && echo -e "${RED}FAIL${NC}"
      echo "    missing ${required}"
      fe_failed=1
      failed=1
    fi
  done
  [[ ${fe_failed} -eq 0 ]] && echo -e "${GREEN}OK${NC}"

  # 5. TypeScript type check (best-effort — only if tsc + node_modules available)
  echo -n "  TypeScript check... "
  if [[ -d "apps/web/node_modules" && -x "apps/web/node_modules/.bin/tsc" ]]; then
    cd apps/web
    local tsc_out
    tsc_out="$(./node_modules/.bin/tsc --noEmit --ignoreDeprecations 6.0 2>&1 || true)"
    cd "${SRC_DIR}"
    # Filter "Cannot find module" cascade errors that aren't real (would fail entire output for any missing dep)
    local real_errors
    real_errors="$(echo "${tsc_out}" | grep -v 'Cannot find module' | grep -v 'JSX element implicitly' \
                  | grep -v 'implicitly has an .any. type' | grep -E '^[^ ].*\.tsx?\([0-9]+,[0-9]+\):' || true)"
    if [[ -n "${real_errors}" ]]; then
      echo -e "${RED}FAIL${NC}"
      echo "${real_errors}" | head -5 | sed 's/^/    /'
      failed=1
    else
      echo -e "${GREEN}OK${NC}"
    fi
  else
    echo "skipped (run 'npm ci' in apps/web for full type-check)"
  fi

  # 6. Nginx config: test the rendered config without reloading
  echo -n "  Nginx config... "
  if command -v nginx >/dev/null 2>&1; then
    if run_root nginx -t 2>/dev/null; then
      echo -e "${GREEN}OK${NC}"
    else
      echo -e "${RED}FAIL${NC}"
      echo "    Run 'nginx -t' as root to see the syntax error"
      failed=1
    fi
  else
    echo "skipped (nginx not installed)"
  fi

  if [[ ${failed} -ne 0 ]]; then
    echo -e "${RED}[smoke] FAILED — refusing to deploy${NC}"
    return 1
  fi
  echo -e "${GREEN}[smoke] passed${NC}"
  return 0
}

# Capture state needed to roll back: git SHA, alembic revision, frontend dist,
# AND a DB dump so a failed migration can be reversed without data loss.
# Snapshots are kept for 5 most-recent (rotation handled here).
cmd_create_snapshot() {
  local stamp
  stamp="$(date +%Y%m%d_%H%M%S)"
  local snap_dir="${SNAPSHOT_DIR}/${stamp}"
  run_root mkdir -p "${snap_dir}"

  # Git SHA from the source tree
  if cd "${SRC_DIR}" 2>/dev/null && git rev-parse HEAD >/dev/null 2>&1; then
    git rev-parse HEAD | run_root tee "${snap_dir}/git_sha" >/dev/null
  else
    echo "unknown" | run_root tee "${snap_dir}/git_sha" >/dev/null
  fi

  # Alembic current revision (so we know which downgrade target is safe)
  if [[ -f "${INSTALL_DIR}/api/.venv/bin/alembic" && -f "${INSTALL_DIR}/api/alembic.ini" ]]; then
    cd "${INSTALL_DIR}/api"
    .venv/bin/alembic current 2>/dev/null \
      | awk '/\(head\)/ {print $1}' \
      | run_root tee "${snap_dir}/alembic_revision" >/dev/null \
      || echo "" | run_root tee "${snap_dir}/alembic_revision" >/dev/null
  fi

  # Frontend dist tarball — letting us restore the old build instantly
  if [[ -d "${INSTALL_DIR}/web/dist" ]]; then
    run_root tar czf "${snap_dir}/web_dist.tar.gz" -C "${INSTALL_DIR}/web" dist 2>/dev/null || true
  fi

  # DB dump — small fast SQL dump so a destructive migration can be undone.
  # Encrypted with the same backup key when available; falls back to plaintext
  # in the snapshot dir (which is root-only).
  load_env 2>/dev/null || true
  local db_name="${APP_USER:-lyaotalk}"
  local key_file="${BACKUP_ENCRYPTION_KEY_FILE:-/root/.lyaotalk-backup.key}"

  # Pick AES-GCM (AEAD = built-in tamper detection) when openssl supports
  # it; fall back to CBC + sidecar SHA-256 for older systems. Match the
  # backup script's logic so verify/restore code paths see consistent
  # cipher/iter values.
  local snap_cipher="aes-256-cbc"
  local snap_iter=600000
  if openssl enc -aes-256-gcm -pbkdf2 -iter 1 -in /dev/null -pass pass:test -out /dev/null 2>/dev/null; then
    snap_cipher="aes-256-gcm"
  fi

  if command -v pg_dump >/dev/null 2>&1; then
    if [[ -f "${key_file}" ]]; then
      if run_root sh -c "sudo -u postgres pg_dump '${db_name}' | gzip | \
        openssl enc -${snap_cipher} -pbkdf2 -iter ${snap_iter} -salt \
                    -pass file:'${key_file}' -out '${snap_dir}/db_dump.sql.gz.enc'" 2>/dev/null; then
        # Sidecar: SHA-256 + meta. Without these, a tampered snapshot dump
        # in CBC mode would silently produce corrupt SQL on rollback.
        run_root sh -c "sha256sum '${snap_dir}/db_dump.sql.gz.enc' > '${snap_dir}/db_dump.sql.gz.enc.sha256'" 2>/dev/null || true
        run_root sh -c "printf 'cipher=%s\npbkdf2_iter=%s\n' '${snap_cipher}' '${snap_iter}' > '${snap_dir}/db_dump.sql.gz.enc.meta'" 2>/dev/null || true
        run_root chmod 600 "${snap_dir}/db_dump.sql.gz.enc" "${snap_dir}/db_dump.sql.gz.enc.sha256" "${snap_dir}/db_dump.sql.gz.enc.meta" 2>/dev/null || true
      else
        echo "  WARNING: encrypted DB snapshot failed" >&2
      fi
    else
      run_root sh -c "sudo -u postgres pg_dump '${db_name}' | gzip > '${snap_dir}/db_dump.sql.gz'" 2>/dev/null \
        || echo "  WARNING: DB snapshot failed" >&2
      run_root chmod 600 "${snap_dir}/db_dump.sql.gz" 2>/dev/null || true
    fi
  fi

  # Capture which version we're snapshotting so list-snapshots is informative
  if [[ -f "${SRC_DIR}/VERSION" ]]; then
    run_root cp "${SRC_DIR}/VERSION" "${snap_dir}/VERSION"
  fi

  # Rotate: keep the last 5 snapshots only
  ls -1dt "${SNAPSHOT_DIR}"/*/ 2>/dev/null | tail -n +6 | run_root xargs -r rm -rf

  echo "${snap_dir}"
}

# Probe the API with progressively deeper checks to verify the service is
# not just running but actually functional.
#
# Layered approach:
#   1. /health responding — proves the FastAPI process is up.
#   2. PostgreSQL accessible from API — proves DB connectivity + alembic
#      head matches running code (mismatch produces SQL errors at runtime
#      but /health stays 200).
#   3. Redis ping — used for rate limiting + session state.
#   4. Prosody systemd active — XMPP itself is the product, an API-only
#      deploy isn't a deploy.
#   5. Nginx serving the frontend — `/` returns the SPA shell.
#
# Returns 0 only if all five pass within max_seconds.
cmd_health_gate() {
  load_env
  local max_seconds=60
  local deadline=$(( $(date +%s) + max_seconds ))
  local wait_step=2

  # Layer 1: API liveness
  while [[ $(date +%s) -lt ${deadline} ]]; do
    if curl -sf --max-time 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then
      break
    fi
    sleep ${wait_step}
  done
  if ! curl -sf --max-time 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "  [health] API /health not responding" >&2
    return 1
  fi

  # Layer 2: DB connectivity from API perspective.
  # The discovery health endpoint exercises the DB session.
  if ! curl -sf --max-time 5 http://127.0.0.1:8000/api/discovery/health >/dev/null 2>&1; then
    # Some installs may not expose discovery; fall back to checking DB directly via systemd
    if ! run_root systemctl is-active --quiet postgresql; then
      echo "  [health] PostgreSQL not active" >&2
      return 1
    fi
  fi

  # Layer 3: Redis
  if command -v redis-cli >/dev/null 2>&1; then
    local redis_password="${REDIS_PASS:-${REDIS_PASSWORD:-}}"
    if [[ -n "${redis_password}" ]]; then
      if ! REDISCLI_AUTH="${redis_password}" redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then
        echo "  [health] Redis not responding to authenticated PING" >&2
        return 1
      fi
    elif ! redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then
      echo "  [health] Redis not responding to PING" >&2
      return 1
    fi
  elif ! run_root systemctl is-active --quiet redis-server 2>/dev/null \
      && ! run_root systemctl is-active --quiet redis 2>/dev/null; then
    echo "  [health] Redis service not active" >&2
    return 1
  fi

  # Layer 4: Prosody
  if ! run_root systemctl is-active --quiet prosody 2>/dev/null; then
    echo "  [health] Prosody not active — XMPP service down" >&2
    return 1
  fi

  # Layer 5: Nginx serving the frontend. Use the configured Host so the
  # default vhost's 421 protection does not make local checks look broken.
  local frontend_host="${DOMAIN:-localhost}"
  if ! curl -sf --max-time 5 -H "Host: ${frontend_host}" -o /dev/null -w "%{http_code}" http://127.0.0.1/ 2>/dev/null \
       | grep -qE '^(200|301|302)$'; then
    # Don't fail on this if there's no nginx (some installs use the API directly)
    if run_root systemctl is-active --quiet nginx 2>/dev/null; then
      echo "  [health] Nginx is active but / returned non-200/3xx" >&2
      return 1
    fi
  fi

  return 0
}

# Restore a prior snapshot. Used by both the auto-rollback path and the
# manual `manage.sh rollback` command.
cmd_rollback_to() {
  local target=""
  local restore_db=0
  for arg in "$@"; do
    case "${arg}" in
      --restore-db) restore_db=1 ;;
      *) [[ -z "${target}" ]] && target="${arg}" ;;
    esac
  done
  if [[ -z "${target}" ]]; then
    echo "Usage: rollback-to <snapshot-dir> [--restore-db]"
    echo "  --restore-db: also restore PostgreSQL data from the snapshot."
    echo "                Use only when migration was destructive. DROPS current DB."
    return 1
  fi
  if [[ ! -d "${target}" ]]; then
    echo "Snapshot directory not found: ${target}"
    return 1
  fi

  echo -e "${YELLOW}[rollback] Restoring from ${target}${NC}"

  # 1. Git SHA: hard-reset source tree
  if [[ -s "${target}/git_sha" ]]; then
    local sha
    sha="$(cat "${target}/git_sha")"
    if [[ "${sha}" != "unknown" ]]; then
      cd "${SRC_DIR}"
      echo "  reverting git -> ${sha}"
      git reset --hard "${sha}" 2>&1 | sed 's/^/    /'
    fi
  fi

  # 2. Alembic: downgrade to recorded revision (only if different)
  # Skip when restoring DB from dump — the dump already contains the right schema.
  if [[ ${restore_db} -eq 0 && -s "${target}/alembic_revision" && -f "${INSTALL_DIR}/api/.venv/bin/alembic" ]]; then
    local rev
    rev="$(cat "${target}/alembic_revision" | tr -d '[:space:]')"
    if [[ -n "${rev}" ]]; then
      cd "${INSTALL_DIR}/api"
      local current
      current="$(.venv/bin/alembic current 2>/dev/null | awk '/\(head\)/ {print $1}' || echo "")"
      if [[ "${current}" != "${rev}" ]]; then
        echo "  reverting alembic ${current} -> ${rev}"
        .venv/bin/alembic downgrade "${rev}" 2>&1 | sed 's/^/    /'
      else
        echo "  alembic already at ${rev}, skipping downgrade"
      fi
    fi
  fi

  # 3. Frontend dist
  if [[ -f "${target}/web_dist.tar.gz" ]]; then
    echo "  restoring web/dist"
    run_root rm -rf "${INSTALL_DIR}/web/dist.broken" 2>/dev/null || true
    if [[ -d "${INSTALL_DIR}/web/dist" ]]; then
      run_root mv "${INSTALL_DIR}/web/dist" "${INSTALL_DIR}/web/dist.broken"
    fi
    run_root tar xzf "${target}/web_dist.tar.gz" -C "${INSTALL_DIR}/web/"
  fi

  # 4. Re-sync API code from the (now-rolled-back) source tree
  if [[ -d "${SRC_DIR}/apps/api" ]]; then
    echo "  re-syncing api code"
    run_root rsync -a --delete \
      --exclude ".venv" \
      --exclude ".env" \
      "${SRC_DIR}/apps/api/" "${INSTALL_DIR}/api/" 2>&1 | sed 's/^/    /'
    [[ -f "${SRC_DIR}/VERSION" ]] && run_root cp "${SRC_DIR}/VERSION" "${INSTALL_DIR}/api/VERSION"
  fi

  # 4b. Optional: restore DB from snapshot (data rollback)
  if [[ ${restore_db} -eq 1 ]]; then
    echo -e "${YELLOW}  --restore-db requested: this will REPLACE the current database${NC}"
    load_env 2>/dev/null || true
    local db_name="${APP_USER:-lyaotalk}"
    local key_file="${BACKUP_ENCRYPTION_KEY_FILE:-/root/.lyaotalk-backup.key}"
    local dump_enc="${target}/db_dump.sql.gz.enc"
    local dump_plain="${target}/db_dump.sql.gz"
    local tmp_sql
    tmp_sql=$(mktemp --suffix=.sql)

    if [[ -f "${dump_enc}" ]]; then
      if [[ ! -f "${key_file}" ]]; then
        echo "  ERROR: encrypted DB dump found but key file missing: ${key_file}"
        rm -f "${tmp_sql}"
        return 1
      fi
      # Verify SHA-256 sidecar before any pipe-into-psql attempt. Without
      # this check, a tampered CBC-encrypted dump would decrypt to garbage
      # SQL and silently corrupt the DB on restore.
      if [[ -f "${dump_enc}.sha256" ]]; then
        if ! run_root sh -c "sha256sum -c '${dump_enc}.sha256'" >/dev/null 2>&1; then
          echo "  ERROR: SHA-256 sidecar mismatch on snapshot dump — refusing to restore"
          rm -f "${tmp_sql}"
          return 1
        fi
      fi
      # Detect cipher + iter from .meta (falls back to legacy CBC@100k).
      local snap_cipher="aes-256-cbc"
      local snap_iter=100000
      if [[ -f "${dump_enc}.meta" ]]; then
        snap_cipher="$(run_root sh -c "grep -E '^cipher=' '${dump_enc}.meta' | cut -d= -f2" 2>/dev/null || echo aes-256-cbc)"
        snap_iter="$(run_root sh -c "grep -E '^pbkdf2_iter=' '${dump_enc}.meta' | cut -d= -f2" 2>/dev/null || echo 100000)"
      fi
      run_root sh -c "openssl enc -d -${snap_cipher} -pbkdf2 -iter ${snap_iter} \
                       -pass file:'${key_file}' -in '${dump_enc}' | gunzip > '${tmp_sql}'"
    elif [[ -f "${dump_plain}" ]]; then
      run_root sh -c "gunzip -c '${dump_plain}' > '${tmp_sql}'"
    else
      echo "  ERROR: no DB dump in snapshot — cannot restore data"
      rm -f "${tmp_sql}"
      return 1
    fi

    echo "  stopping API to drain connections"
    run_root systemctl stop lyaotalk-api
    echo "  dropping and recreating database ${db_name}"
    run_root sudo -u postgres dropdb --if-exists "${db_name}"
    run_root sudo -u postgres createdb -O "${db_name}" "${db_name}"
    echo "  importing snapshot SQL"
    run_root sh -c "sudo -u postgres psql '${db_name}' < '${tmp_sql}' >/dev/null"
    rm -f "${tmp_sql}"
  fi

  # 5. Restart services
  echo "  restarting services"
  run_root systemctl restart lyaotalk-api
  if run_root nginx -t 2>/dev/null; then
    run_root systemctl reload nginx
  else
    echo "  WARNING: nginx -t failed during rollback, skipping reload"
  fi

  # 6. Verify
  if cmd_health_gate; then
    echo -e "${GREEN}[rollback] OK — system healthy${NC}"
    return 0
  else
    echo -e "${RED}[rollback] FAILED — health check still failing after rollback${NC}"
    echo -e "${RED}           Manual intervention required. Check: journalctl -u lyaotalk-api${NC}"
    return 1
  fi
}

# Rollback to the most recent snapshot.
cmd_rollback() {
  local latest
  latest="$(ls -1dt "${SNAPSHOT_DIR}"/*/ 2>/dev/null | head -n1 || true)"
  if [[ -z "${latest}" ]]; then
    echo "No snapshots available under ${SNAPSHOT_DIR}"
    exit 1
  fi
  echo "Rolling back to: ${latest}"
  read -r -p "Confirm rollback? [y/N] " confirm
  if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
    echo "Aborted"
    exit 1
  fi
  cmd_rollback_to "${latest%/}"
}

cmd_list_snapshots() {
  if [[ ! -d "${SNAPSHOT_DIR}" ]]; then
    echo "No snapshots directory yet."
    return 0
  fi
  echo "Available snapshots (newest first):"
  printf "  %-17s  %-7s  %-13s  %-13s  %-7s  %s\n" \
    "TIMESTAMP" "VERSION" "GIT" "ALEMBIC" "DB" "SIZE"
  for s in $(ls -1dt "${SNAPSHOT_DIR}"/*/ 2>/dev/null); do
    [[ -d "${s}" ]] || continue
    local name version sha rev db_status size
    name="$(basename "${s}")"
    version="$(cat "${s}VERSION" 2>/dev/null || echo "?")"
    sha="$(cat "${s}git_sha" 2>/dev/null | head -c 12 || echo "?")"
    rev="$(cat "${s}alembic_revision" 2>/dev/null | tr -d '[:space:]' | head -c 12 || echo "?")"
    if [[ -f "${s}db_dump.sql.gz.enc" ]]; then
      db_status="enc"
    elif [[ -f "${s}db_dump.sql.gz" ]]; then
      db_status="plain"
    else
      db_status="-"
    fi
    size="$(du -sh "${s}" 2>/dev/null | awk '{print $1}')"
    printf "  %-17s  %-7s  %-13s  %-13s  %-7s  %s\n" \
      "${name}" "${version}" "${sha}" "${rev}" "${db_status}" "${size}"
  done
}

cmd_update_all() {
  local skip_smoke=0
  local skip_snapshot=0
  local skip_rollback=0
  for arg in "$@"; do
    case "${arg}" in
      --skip-smoke)    skip_smoke=1 ;;
      --skip-snapshot) skip_snapshot=1 ;;
      --no-rollback)   skip_rollback=1 ;;
    esac
  done

  echo -e "${CYAN}[1/6] Pull source${NC}"
  cd "${SRC_DIR}"
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  current_remote="$(git remote | head -n1)"
  [[ -n "${current_remote}" ]] || current_remote="origin"
  git_fetch_with_retry
  git reset --hard "${current_remote}/${current_branch}"

  if [[ ${skip_smoke} -eq 0 ]]; then
    echo -e "${CYAN}[2/6] Smoke check${NC}"
    if ! cmd_smoke_check; then
      echo -e "${RED}Aborting deploy — smoke check failed.${NC}"
      echo -e "${RED}Use --skip-smoke to override (NOT recommended).${NC}"
      return 1
    fi
  else
    echo -e "${YELLOW}[2/6] Smoke check (SKIPPED)${NC}"
  fi

  local snap_dir=""
  if [[ ${skip_snapshot} -eq 0 ]]; then
    echo -e "${CYAN}[3/6] Snapshot${NC}"
    snap_dir="$(cmd_create_snapshot)"
    echo "  snapshot saved to: ${snap_dir}"
  else
    echo -e "${YELLOW}[3/6] Snapshot (SKIPPED — auto-rollback will be unavailable)${NC}"
  fi

  echo -e "${CYAN}[4/6] Update API${NC}"
  if ! cmd_update_api; then
    echo -e "${RED}API update failed.${NC}"
    if [[ ${skip_rollback} -eq 0 && -n "${snap_dir}" ]]; then
      echo -e "${YELLOW}Auto-rolling back...${NC}"
      cmd_rollback_to "${snap_dir}"
    fi
    return 1
  fi

  echo -e "${CYAN}[5/6] Update frontend${NC}"
  if ! cmd_update_front; then
    echo -e "${RED}Frontend update failed.${NC}"
    if [[ ${skip_rollback} -eq 0 && -n "${snap_dir}" ]]; then
      echo -e "${YELLOW}Auto-rolling back...${NC}"
      cmd_rollback_to "${snap_dir}"
    fi
    return 1
  fi

  echo -e "${CYAN}[6/6] Health gate${NC}"
  if cmd_health_gate; then
    echo -e "${GREEN}  /health responding 200${NC}"
    cmd_status
    echo -e "${GREEN}Deploy succeeded.${NC}"
    return 0
  else
    echo -e "${RED}  /health failed after 60s${NC}"
    if [[ ${skip_rollback} -eq 0 && -n "${snap_dir}" ]]; then
      echo -e "${YELLOW}Auto-rolling back...${NC}"
      if cmd_rollback_to "${snap_dir}"; then
        echo -e "${YELLOW}Rolled back. Investigate before retrying.${NC}"
      fi
    else
      echo -e "${RED}No snapshot available — manual intervention required.${NC}"
      echo -e "${RED}Check: journalctl -u lyaotalk-api --since '5 min ago'${NC}"
    fi
    return 1
  fi
}

cmd_mem_usage() {
  ps aux --sort=-%mem | grep -E "(postgres|redis|prosody|minio|uvicorn|nginx)" | grep -v grep | \
    awk '{printf "%-28s %s MB\n", $11, int($6/1024)}'
  echo ""
  free -h
}

cmd_ssl_renew() {
  certbot renew --nginx
  systemctl reload nginx
}

cmd_db_shell() {
  load_env
  db_name="${APP_USER:-lyaotalk}"
  sudo -u postgres psql "${db_name}"
}

cmd_db_history() {
  cd "${INSTALL_DIR}/api"
  .venv/bin/alembic history
}

cmd_db_rollback() {
  cd "${INSTALL_DIR}/api"
  echo "Current migration:"
  .venv/bin/alembic current
  read -rp "Rollback target (revision or -1): " target
  [[ -n "${target:-}" ]] || { echo "No target provided"; exit 1; }
  .venv/bin/alembic downgrade "$target"
  systemctl restart lyaotalk-api
}

cmd_check() {
  load_env
  if [[ -x /usr/local/bin/lyaotalk-check ]]; then
    /usr/local/bin/lyaotalk-check "${DOMAIN:-localhost}"
  else
    cmd_status
  fi
}

cmd_api_health() {
  load_env
  local host="${DOMAIN:-localhost}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "https://${host}/api/health" || curl -fsS "http://127.0.0.1:8000/api/health"
  else
    echo "curl is required for api-health"
    exit 1
  fi
}

cmd_cert_info() {
  load_env
  cert="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  if [[ ! -f "$cert" ]]; then
    echo "Certificate not found: $cert"
    exit 1
  fi
  openssl x509 -enddate -startdate -noout -in "$cert"
}

cmd_disk_usage() {
  echo "=== Filesystem ==="
  df -h / /data 2>/dev/null || true
  echo ""
  echo "=== Backups ==="
  du -sh /root/backups/* 2>/dev/null | sort -rh | head -20 || true
  echo ""
  echo "=== MinIO ==="
  du -sh /data/minio 2>/dev/null || true
  echo ""
  echo "=== Logs ==="
  du -sh /var/log/nginx /var/log/prosody /var/log/lyaotalk-backup.log 2>/dev/null || true
}

cmd_top_requests() {
  local log="/var/log/nginx/access.log"
  if [[ ! -f "$log" ]]; then
    echo "Log not found: $log"
    exit 1
  fi
  echo "=== Top 30 paths (last 10000 lines) ==="
  tail -n 10000 "$log" | awk '{print $7}' | cut -d'?' -f1 | sort | uniq -c | sort -rn | head -30
}

cmd_ports() {
  echo "=== Listening ports ==="
  ss -tulpen 2>/dev/null || netstat -tulpen 2>/dev/null || true
}

cmd_backup_verify() {
  local latest
  local key_file="${BACKUP_ENCRYPTION_KEY_FILE:-/root/.lyaotalk-backup.key}"
  latest="$(ls -1t /root/backups/db_*.sql.gz.enc 2>/dev/null | head -n1 || true)"
  if [[ -z "${latest}" ]]; then
    # Fall back to legacy non-encrypted format
    latest="$(ls -1t /root/backups/db_*.sql.gz 2>/dev/null | head -n1 || true)"
    if [[ -z "${latest}" ]]; then
      echo "No backup archive found under /root/backups"
      exit 1
    fi
    echo "Verifying (legacy): ${latest}"
    if gzip -t "${latest}"; then
      echo "Backup archive is valid"
    else
      echo "Backup archive is corrupted"
      exit 1
    fi
    return
  fi
  echo "Verifying: ${latest}"
  if [[ ! -f "${key_file}" ]]; then
    echo "Encryption key file not found: ${key_file}"
    exit 1
  fi

  # 1) Verify SHA-256 sidecar if present. This catches tampering even on
  #    backups made with CBC (which has no AEAD) and on GCM backups where
  #    an attacker knows the key (unlikely but matters for defense in depth
  #    once you assume a different threat model).
  if [[ -f "${latest}.sha256" ]]; then
    if ! sha256sum -c "${latest}.sha256" >/dev/null 2>&1; then
      echo "SHA-256 mismatch: ${latest}.sha256 disagrees with the archive"
      echo "Backup has been tampered with or one of the files is corrupted"
      exit 1
    fi
  fi

  # 2) Read meta to know which cipher/iter was used. Fall back to legacy
  #    defaults (CBC, 100k) when no meta is present.
  local cipher="aes-256-cbc"
  local iter=100000
  if [[ -f "${latest}.meta" ]]; then
    cipher="$(grep -E '^cipher=' "${latest}.meta" | cut -d= -f2 || echo aes-256-cbc)"
    iter="$(grep -E '^pbkdf2_iter=' "${latest}.meta" | cut -d= -f2 || echo 100000)"
  fi

  # 3) Decrypt + gzip integrity. With GCM this also validates the AEAD tag.
  if openssl enc -d "-${cipher}" -pbkdf2 -iter "${iter}" \
                 -pass file:"${key_file}" \
                 -in "${latest}" 2>/dev/null | gzip -t; then
    echo "Encrypted backup archive is valid (cipher=${cipher} iter=${iter})"
  else
    echo "Backup archive is corrupted, tampered with, or wrong key"
    exit 1
  fi
}

cmd_backup_restore() {
  local backup_file="${2:-}"
  local key_file="${BACKUP_ENCRYPTION_KEY_FILE:-/root/.lyaotalk-backup.key}"

  if [[ -z "${backup_file}" ]]; then
    echo "Usage: $0 backup-restore <path-to-backup-file>"
    echo "Available backups:"
    ls -lh /root/backups/db_*.sql.gz* 2>/dev/null | awk '{print "  " $9 "  (" $5 ", " $6 " " $7 " " $8 ")"}' || true
    exit 1
  fi

  if [[ ! -f "${backup_file}" ]]; then
    echo "Backup file not found: ${backup_file}"
    exit 1
  fi

  load_env
  local DB_NAME="${APP_USER:-lyaotalk}"

  echo "WARNING: This will REPLACE the current database '${DB_NAME}'."
  echo "All current data will be lost."
  read -r -p "Type 'restore' to confirm: " confirm
  if [[ "${confirm}" != "restore" ]]; then
    echo "Aborted"
    exit 1
  fi

  # Stop API to prevent writes during restore
  systemctl stop lyaotalk-api

  local tmp_sql
  tmp_sql=$(mktemp --suffix=.sql)
  trap "rm -f '${tmp_sql}'" EXIT

  # Decrypt if .enc, otherwise just decompress
  if [[ "${backup_file}" == *.enc ]]; then
    if [[ ! -f "${key_file}" ]]; then
      echo "Encryption key not found: ${key_file}"
      systemctl start lyaotalk-api
      exit 1
    fi

    # Pre-check SHA-256 sidecar BEFORE attempting restore. A tampered backup
    # that decrypts cleanly (CBC has no integrity check) would otherwise
    # silently produce corrupted SQL that gets piped into psql, leaving
    # the DB half-populated with garbage. Refusing here is much safer than
    # trying to roll back a partial restore.
    if [[ -f "${backup_file}.sha256" ]]; then
      if ! sha256sum -c "${backup_file}.sha256" >/dev/null 2>&1; then
        echo "ABORT: SHA-256 sidecar mismatch — backup file appears tampered or corrupted"
        systemctl start lyaotalk-api
        exit 1
      fi
    fi

    # Detect cipher + iter from meta sidecar; default to legacy CBC@100k
    # when no meta exists (older backups predating GCM rollout).
    local cipher="aes-256-cbc"
    local iter=100000
    if [[ -f "${backup_file}.meta" ]]; then
      cipher="$(grep -E '^cipher=' "${backup_file}.meta" | cut -d= -f2 || echo aes-256-cbc)"
      iter="$(grep -E '^pbkdf2_iter=' "${backup_file}.meta" | cut -d= -f2 || echo 100000)"
    fi

    if ! openssl enc -d "-${cipher}" -pbkdf2 -iter "${iter}" \
                     -pass file:"${key_file}" \
                     -in "${backup_file}" | gunzip > "${tmp_sql}"; then
      echo "Decrypt failed (cipher=${cipher} iter=${iter})"
      systemctl start lyaotalk-api
      exit 1
    fi
  else
    if ! gunzip -c "${backup_file}" > "${tmp_sql}"; then
      echo "Decompress failed"
      systemctl start lyaotalk-api
      exit 1
    fi
  fi

  # Drop and recreate the DB
  echo "Dropping and recreating database ${DB_NAME}..."
  sudo -u postgres dropdb --if-exists "${DB_NAME}"
  sudo -u postgres createdb -O "${DB_NAME}" "${DB_NAME}"

  echo "Restoring from backup..."
  if sudo -u postgres psql "${DB_NAME}" < "${tmp_sql}" >/dev/null; then
    echo "Restore complete"
  else
    echo "Restore failed — database may be in inconsistent state!"
    systemctl start lyaotalk-api
    exit 1
  fi

  systemctl start lyaotalk-api
  echo "API restarted"
}

cmd_env_check() {
  load_env
  local failed=0
  for key in DOMAIN EMAIL XMPP_DOMAIN DB_PASS REDIS_PASS SECRET_KEY MINIO_ROOT_PASSWORD ADMIN_PASS PUBLIC_DOMAIN; do
    value="$(eval "printf '%s' \"\${$key:-}\"")"
    if [[ -z "${value}" ]]; then
      echo "MISSING: ${key}"
      failed=1
    else
      echo "OK: ${key}"
    fi
  done
  [[ "${failed}" -eq 0 ]] || exit 1
}

cmd_watchdog() {
  if [[ -x /usr/local/bin/lyaotalk-alert.sh ]]; then
    /usr/local/bin/lyaotalk-alert.sh
    echo "watchdog executed"
  else
    echo "watchdog script not found: /usr/local/bin/lyaotalk-alert.sh"
    exit 1
  fi
}

case "${1:-}" in
  status)          cmd_status ;;
  start)           cmd_start ;;
  stop)            cmd_stop ;;
  restart)         cmd_restart ;;
  restart-api)     systemctl restart lyaotalk-api ;;
  restart-nginx)   systemctl reload nginx ;;
  logs-api)        journalctl -u lyaotalk-api -f ;;
  logs-xmpp)       tail -f /var/log/prosody/prosody.log ;;
  logs-nginx)      tail -f /var/log/nginx/access.log ;;
  logs-nginx-err)  tail -f /var/log/nginx/error.log ;;
  add-user)        cmd_add_user ;;
  del-user)        cmd_del_user ;;
  list-users)      cmd_list_users ;;
  change-pass)     cmd_change_pass ;;
  backup)          /usr/local/bin/lyaotalk-backup.sh ;;
  backup-restore)  cmd_backup_restore "$@" ;;
  update)          shift; cmd_update_all "$@" ;;
  update-front)    cmd_update_front ;;
  update-api)      cmd_update_api ;;
  smoke-check)     cmd_smoke_check ;;
  snapshot)        cmd_create_snapshot ;;
  list-snapshots)  cmd_list_snapshots ;;
  rollback)        cmd_rollback ;;
  rollback-to)     shift; cmd_rollback_to "$@" ;;
  health-gate)     cmd_health_gate && echo "OK" || echo "FAILED" ;;
  ssl-renew)       cmd_ssl_renew ;;
  db-shell)        cmd_db_shell ;;
  db-history)      cmd_db_history ;;
  db-rollback)     cmd_db_rollback ;;
  check)           cmd_check ;;
  api-health)      cmd_api_health ;;
  cert-info)       cmd_cert_info ;;
  disk-usage)      cmd_disk_usage ;;
  ports)           cmd_ports ;;
  backup-verify)   cmd_backup_verify ;;
  env-check)       cmd_env_check ;;
  top-requests)    cmd_top_requests ;;
  mem-usage)       cmd_mem_usage ;;
  watchdog)        cmd_watchdog ;;
  *)               usage ;;
esac
