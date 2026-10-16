#!/usr/bin/env bash
# =============================================================================
#  Target: apt-based Linux with systemd (Debian/Ubuntu/Zorin/etc.)
#  Usage:  bash install.sh --repo <repo_url> --domain <domain> --email <email>
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }
step()    { echo -e "\n${CYAN}=== $* ===${NC}"; }

is_placeholder_domain() {
  case "${1:-}" in
    ""|chat.yourdomain.com|chat.example.com|example.com) return 0 ;;
    *) return 1 ;;
  esac
}

is_placeholder_email() {
  case "${1:-}" in
    ""|you@example.com|example@example.com) return 0 ;;
    *) return 1 ;;
  esac
}

INSTALL_DIR="/opt/liaot"
APP_USER="liaot"
MINIO_USER="minio-user"
DOMAIN=""
EMAIL=""
SRC_DIR=""
RUN_LOCAL=0
REPO_URL=""
BRANCH="main"
PROJECT_PATH=""
TARGET_DIR="/opt/liaot-src"
SSH_PORT="${SSH_PORT:-}"
XMPP_ADMIN_USER="admin"
XMPP_ADMIN_PASS="${XMPP_ADMIN_PASS:-}"
XMPP_ADMIN_CREATED=0
XMPP_ADMIN_JID=""
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"
AI_API_KEY="${AI_API_KEY:-}"
AI_BASE_URL="${AI_BASE_URL:-}"
AI_MODEL="${AI_MODEL:-}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
DB_POOL_SIZE="${DB_POOL_SIZE:-10}"
DB_MAX_OVERFLOW="${DB_MAX_OVERFLOW:-20}"
DB_POOL_TIMEOUT="${DB_POOL_TIMEOUT:-30}"
DB_POOL_RECYCLE="${DB_POOL_RECYCLE:-1800}"
OS_ID=""
OS_VERSION_ID=""
OS_VERSION_CODENAME=""
OS_ID_LIKE=""
APT_FRONTEND_READY=0
PYTHON_BIN=""
POSTGRES_VERSION=""
UPGRADE_SYSTEM="${UPGRADE_SYSTEM:-0}"
CONFIGURE_ONLY=0

ensure_service_users() {
  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    useradd -r -s /usr/sbin/nologin "${APP_USER}"
  fi
  if ! id -u "${MINIO_USER}" >/dev/null 2>&1; then
    useradd -r -s /usr/sbin/nologin "${MINIO_USER}"
  fi
}

bootstrap_usage() {
  cat <<'EOF'
Usage:
  bash install.sh --repo <github_repo_url> --domain <your_domain> --email <your_email> [options]

Required:
  --repo      Git repository URL, for example: https://github.com/stone086/LyaoTalk.git
  --domain    Public domain, for example: chat.example.com
  --email     Email for Let's Encrypt certificate notices

Optional:
  --branch    Git branch to install from (default: main)
  --path      Project path inside repo; auto-detected if omitted
  --target    Clone target directory (default: /opt/liaot-src)
  --ssh-port  SSH port(s) to keep open in UFW, supports comma/space list (default: auto-detect)
  --upgrade-system
              Run apt-get upgrade before installing dependencies (default: skip)
  --configure
              Run the interactive .env wizard, validate, then exit
  --run-local Internal mode. Do not set manually.
  --help      Show this help
EOF
}

parse_bootstrap_args() {
  # Repo-local mode: allow direct `bash install.sh` without parameters.
  if [[ $# -eq 0 && -f ".env.example" && -d "apps/api" && -d "apps/web" ]]; then
    RUN_LOCAL=1
    return
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) REPO_URL="${2:-}"; shift 2 ;;
      --domain) DOMAIN="${2:-}"; shift 2 ;;
      --email) EMAIL="${2:-}"; shift 2 ;;
      --branch) BRANCH="${2:-}"; shift 2 ;;
      --path) PROJECT_PATH="${2:-}"; shift 2 ;;
      --target) TARGET_DIR="${2:-}"; shift 2 ;;
      --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
      --upgrade-system) UPGRADE_SYSTEM=1; shift ;;
      --configure) CONFIGURE_ONLY=1; RUN_LOCAL=1; shift ;;
      --run-local) RUN_LOCAL=1; shift ;;
      --help|-h) bootstrap_usage; exit 0 ;;
      *) error "Unknown option: $1" ;;
    esac
  done
}

bootstrap_if_needed() {
  if [[ "$RUN_LOCAL" -eq 1 ]]; then
    return
  fi

  [[ -n "$REPO_URL" ]] || { bootstrap_usage; error "--repo is required"; }
  if is_placeholder_domain "$DOMAIN" && [[ -t 0 ]]; then
    read -rp "Enter your real domain (for example: chat.yourdomain.com): " DOMAIN
    DOMAIN="${DOMAIN// /}"
  fi
  if is_placeholder_email "$EMAIL" && [[ -t 0 ]]; then
    read -rp "Enter your email for SSL certificate notices: " EMAIL
    EMAIL="${EMAIL// /}"
  fi
  is_placeholder_domain "$DOMAIN" && { bootstrap_usage; error "--domain is required and must not be a placeholder"; }
  is_placeholder_email "$EMAIL" && { bootstrap_usage; error "--email is required and must not be a placeholder"; }
  [[ "$(id -u)" -eq 0 ]] || error "Please run as root"

  info "Preparing dependencies..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git ca-certificates

  if [[ -d "$TARGET_DIR/.git" ]]; then
    info "Existing source detected, refreshing: $TARGET_DIR"
    git -C "$TARGET_DIR" fetch --all --prune
    git -C "$TARGET_DIR" reset --hard "origin/$BRANCH"
  else
    info "Cloning $REPO_URL ($BRANCH) into $TARGET_DIR"
    rm -rf "$TARGET_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
  fi

  local install_src
  if [[ -n "$PROJECT_PATH" ]]; then
    install_src="$TARGET_DIR/$PROJECT_PATH"
  elif [[ -f "$TARGET_DIR/install.sh" ]]; then
    install_src="$TARGET_DIR"
  elif [[ -f "$TARGET_DIR/web_Conji_native/install.sh" ]]; then
    install_src="$TARGET_DIR/web_Conji_native"
  else
    error "Cannot find install.sh. Use --path to specify project directory inside repo."
  fi

  cd "$install_src"
  [[ -f ".env.example" ]] || error ".env.example not found in $install_src"
  [[ -f "install.sh" ]] || error "install.sh not found in $install_src"

  if [[ ! -f ".env" ]]; then
    cp .env.example .env
  fi

  set_env() {
    local key="$1"
    local value="$2"
    if grep -qE "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      echo "${key}=${value}" >> .env
    fi
  }

  set_env "DOMAIN" "$DOMAIN"
  set_env "EMAIL" "$EMAIL"
  CURRENT_XMPP_DOMAIN="$(grep -E '^XMPP_DOMAIN=' .env | head -n1 | cut -d= -f2- || true)"
  if [[ -z "$CURRENT_XMPP_DOMAIN" ]] || is_placeholder_domain "$CURRENT_XMPP_DOMAIN"; then
    set_env "XMPP_DOMAIN" "$DOMAIN"
  fi

  chmod +x install.sh manage.sh
  info "Starting install in $install_src"
  local run_args=(--run-local)
  [[ "${UPGRADE_SYSTEM}" = "1" ]] && run_args+=(--upgrade-system)
  if [[ -n "${SSH_PORT:-}" ]]; then
    run_args+=(--ssh-port "$SSH_PORT")
  fi
  exec bash install.sh "${run_args[@]}"
}

load_config() {
  if [ ! -f ".env" ]; then
    if [[ -t 0 && -x "scripts/env_wizard.sh" ]]; then
      warn ".env file not found; starting interactive configuration wizard."
      bash scripts/env_wizard.sh
    else
      error ".env file not found. Run: bash scripts/env_wizard.sh"
    fi
  fi
  # Normalize CRLF to LF to avoid hidden '\r' in secrets.
  sed -i 's/\r$//' .env
  # Safe .env loader: supports values with spaces without requiring shell quoting.
  # Do not use `source .env`; .env is data, not shell code.
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue

    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    val="$(printf '%s' "$val" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"

    # Strip one layer of surrounding quotes.
    if [[ "$val" =~ ^\".*\"$ ]]; then
      val="${val:1:${#val}-2}"
    elif [[ "$val" =~ ^\'.*\'$ ]]; then
      val="${val:1:${#val}-2}"
    fi

    # Export only valid environment variable names.
    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      export "$key=$val"
    fi
  done < .env

  DOMAIN="${DOMAIN:-}"
  PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-${DOMAIN}}"
  EMAIL="${EMAIL:-}"
  DB_PASS="${DB_PASS:-${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}}"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-${DB_PASS}}"
  REDIS_PASS="${REDIS_PASS:-$(openssl rand -hex 16)}"
  MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
  MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-$(openssl rand -hex 16)}"
  SECRET_KEY="${SECRET_KEY:-$(openssl rand -hex 32)}"
  XMPP_DOMAIN="${XMPP_DOMAIN:-localhost}"
  XMPP_ADMIN_PASS="${XMPP_ADMIN_PASS:-$(openssl rand -hex 12)}"
  ADMIN_USER="${ADMIN_USER:-admin}"
  # Admin password handling — prefer hashed storage so a leaked .env doesn't
  # immediately surrender admin access. Operator can still pass ADMIN_PASS or
  # ADMIN_PASS_HASH explicitly via env; otherwise we generate a random
  # password, print it once for the operator to copy, and persist only the
  # argon2 hash to .env.
  ADMIN_PASS="${ADMIN_PASS:-}"
  ADMIN_PASS_HASH="${ADMIN_PASS_HASH:-}"
  if [[ -z "${ADMIN_PASS}" && -z "${ADMIN_PASS_HASH}" ]]; then
    ADMIN_PASS_GENERATED="$(openssl rand -hex 12)"
    ADMIN_PASS="${ADMIN_PASS_GENERATED}"
    ADMIN_PASS_PRINT_AT_END=1
  fi
  AI_API_KEY="${AI_API_KEY:-}"
  AI_BASE_URL="${AI_BASE_URL:-}"
  AI_MODEL="${AI_MODEL:-}"
  ALERT_EMAIL="${ALERT_EMAIL:-}"
  DB_POOL_SIZE="${DB_POOL_SIZE:-10}"
  DB_MAX_OVERFLOW="${DB_MAX_OVERFLOW:-20}"
  DB_POOL_TIMEOUT="${DB_POOL_TIMEOUT:-30}"
  DB_POOL_RECYCLE="${DB_POOL_RECYCLE:-1800}"
  TURN_SECRET="${TURN_SECRET:-$(openssl rand -hex 32)}"
  LDAP_URL="${LDAP_URL:-${LDAP_SERVER:-}}"
  PROMETHEUS_ALLOW_CIDR="${PROMETHEUS_ALLOW_CIDR:-}"

  # Strip accidental CR characters from sourced values.
  DOMAIN="${DOMAIN//$'\r'/}"
  EMAIL="${EMAIL//$'\r'/}"
  DB_PASS="${DB_PASS//$'\r'/}"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD//$'\r'/}"
  REDIS_PASS="${REDIS_PASS//$'\r'/}"
  MINIO_ROOT_USER="${MINIO_ROOT_USER//$'\r'/}"
  MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD//$'\r'/}"
  SECRET_KEY="${SECRET_KEY//$'\r'/}"
  XMPP_DOMAIN="${XMPP_DOMAIN//$'\r'/}"
  XMPP_ADMIN_PASS="${XMPP_ADMIN_PASS//$'\r'/}"
  BACKUP_REMOTE="${BACKUP_REMOTE//$'\r'/}"
  PUBLIC_DOMAIN="${PUBLIC_DOMAIN//$'\r'/}"
  ADMIN_USER="${ADMIN_USER//$'\r'/}"
  ADMIN_PASS="${ADMIN_PASS//$'\r'/}"
  AI_API_KEY="${AI_API_KEY//$'\r'/}"
  AI_BASE_URL="${AI_BASE_URL//$'\r'/}"
  AI_MODEL="${AI_MODEL//$'\r'/}"
  ALERT_EMAIL="${ALERT_EMAIL//$'\r'/}"
  DB_POOL_SIZE="${DB_POOL_SIZE//$'\r'/}"
  DB_MAX_OVERFLOW="${DB_MAX_OVERFLOW//$'\r'/}"
  DB_POOL_TIMEOUT="${DB_POOL_TIMEOUT//$'\r'/}"
  DB_POOL_RECYCLE="${DB_POOL_RECYCLE//$'\r'/}"
  TURN_SECRET="${TURN_SECRET//$'\r'/}"
  LDAP_URL="${LDAP_URL//$'\r'/}"
  PROMETHEUS_ALLOW_CIDR="${PROMETHEUS_ALLOW_CIDR//$'\r'/}"

  DB_PASS_SQL_ESCAPED="${DB_PASS//\'/\'\'}"
  DB_PASS_URLENCODED="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${DB_PASS}")"

  if is_placeholder_domain "$DOMAIN" && [[ -t 0 ]]; then
    read -rp "Enter your real domain (for example: chat.yourdomain.com): " DOMAIN
    DOMAIN="${DOMAIN// /}"
  fi
  if is_placeholder_email "$EMAIL" && [[ -t 0 ]]; then
    read -rp "Enter your email for SSL certificate notices: " EMAIL
    EMAIL="${EMAIL// /}"
  fi
  is_placeholder_domain "$DOMAIN" && error "Please set a real DOMAIN value in .env (current: ${DOMAIN:-empty})"
  is_placeholder_email "$EMAIL" && error "Please set a real EMAIL value in .env (current: ${EMAIL:-empty})"

  # Persist generated secrets back to .env.
  sed -i "s|^DB_PASS=.*|DB_PASS=${DB_PASS}|" .env
  if grep -qE '^POSTGRES_PASSWORD=' .env; then
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
  else
    echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" >> .env
  fi
  sed -i "s|^REDIS_PASS=.*|REDIS_PASS=${REDIS_PASS}|" .env
  sed -i "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}|" .env
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=${SECRET_KEY}|" .env
  if grep -qE '^XMPP_ADMIN_PASS=' .env; then
    sed -i "s|^XMPP_ADMIN_PASS=.*|XMPP_ADMIN_PASS=${XMPP_ADMIN_PASS}|" .env
  else
    echo "XMPP_ADMIN_PASS=${XMPP_ADMIN_PASS}" >> .env
  fi
  if grep -qE '^TURN_SECRET=' .env; then
    sed -i "s|^TURN_SECRET=.*|TURN_SECRET=${TURN_SECRET}|" .env
  else
    echo "TURN_SECRET=${TURN_SECRET}" >> .env
  fi
  if grep -qE '^BACKUP_REMOTE=' .env; then
    sed -i "s|^BACKUP_REMOTE=.*|BACKUP_REMOTE=${BACKUP_REMOTE}|" .env
  else
    echo "BACKUP_REMOTE=${BACKUP_REMOTE}" >> .env
  fi
  if grep -qE '^PUBLIC_DOMAIN=' .env; then
    sed -i "s|^PUBLIC_DOMAIN=.*|PUBLIC_DOMAIN=${PUBLIC_DOMAIN}|" .env
  else
    echo "PUBLIC_DOMAIN=${PUBLIC_DOMAIN}" >> .env
  fi
  if grep -qE '^ADMIN_USER=' .env; then
    sed -i "s|^ADMIN_USER=.*|ADMIN_USER=${ADMIN_USER}|" .env
  else
    echo "ADMIN_USER=${ADMIN_USER}" >> .env
  fi

  # Compute the argon2 hash of the chosen plaintext password (if we have one)
  # and persist it. We never write the plaintext to .env. If the operator
  # provided ADMIN_PASS_HASH directly, use it as-is.
  if [[ -z "${ADMIN_PASS_HASH}" && -n "${ADMIN_PASS}" ]]; then
    if [[ -x "${INSTALL_DIR}/api/.venv/bin/python" ]]; then
      ADMIN_PASS_HASH="$("${INSTALL_DIR}/api/.venv/bin/python" -c \
        "from argon2 import PasswordHasher; import sys; print(PasswordHasher().hash(sys.argv[1]))" \
        "${ADMIN_PASS}" 2>/dev/null || true)"
    fi
    # Fallback to system python with passlib if venv isn't ready yet
    if [[ -z "${ADMIN_PASS_HASH}" ]] && command -v python3 >/dev/null 2>&1; then
      ADMIN_PASS_HASH="$(python3 -c \
        "from argon2 import PasswordHasher; import sys; print(PasswordHasher().hash(sys.argv[1]))" \
        "${ADMIN_PASS}" 2>/dev/null || true)"
    fi
  fi

  # Remove any legacy plaintext ADMIN_PASS that may be in .env from older installs.
  # Hash is what we actually use; keeping plaintext alongside is a security smell.
  sed -i '/^ADMIN_PASS=/d' .env
  if grep -qE '^ADMIN_PASS_HASH=' .env; then
    sed -i "s|^ADMIN_PASS_HASH=.*|ADMIN_PASS_HASH=${ADMIN_PASS_HASH}|" .env
  else
    echo "ADMIN_PASS_HASH=${ADMIN_PASS_HASH}" >> .env
  fi
  if grep -qE '^AI_API_KEY=' .env; then
    sed -i "s|^AI_API_KEY=.*|AI_API_KEY=${AI_API_KEY}|" .env
  else
    echo "AI_API_KEY=${AI_API_KEY}" >> .env
  fi
  if grep -qE '^AI_BASE_URL=' .env; then
    sed -i "s|^AI_BASE_URL=.*|AI_BASE_URL=${AI_BASE_URL}|" .env
  else
    echo "AI_BASE_URL=${AI_BASE_URL}" >> .env
  fi
  if grep -qE '^AI_MODEL=' .env; then
    sed -i "s|^AI_MODEL=.*|AI_MODEL=${AI_MODEL}|" .env
  else
    echo "AI_MODEL=${AI_MODEL}" >> .env
  fi
  if grep -qE '^ALERT_EMAIL=' .env; then
    sed -i "s|^ALERT_EMAIL=.*|ALERT_EMAIL=${ALERT_EMAIL}|" .env
  else
    echo "ALERT_EMAIL=${ALERT_EMAIL}" >> .env
  fi
  # LDAP_URL is accepted as an installer compatibility alias, but the API
  # settings model uses LDAP_SERVER. Do not persist LDAP_URL into runtime .env.
  if [[ -n "${PROMETHEUS_ALLOW_CIDR}" ]]; then
    if grep -qE '^PROMETHEUS_ALLOW_CIDR=' .env; then
      sed -i "s|^PROMETHEUS_ALLOW_CIDR=.*|PROMETHEUS_ALLOW_CIDR=${PROMETHEUS_ALLOW_CIDR}|" .env
    else
      echo "PROMETHEUS_ALLOW_CIDR=${PROMETHEUS_ALLOW_CIDR}" >> .env
    fi
  fi
  if grep -qE '^DB_POOL_SIZE=' .env; then
    sed -i "s|^DB_POOL_SIZE=.*|DB_POOL_SIZE=${DB_POOL_SIZE}|" .env
  else
    echo "DB_POOL_SIZE=${DB_POOL_SIZE}" >> .env
  fi
  if grep -qE '^DB_MAX_OVERFLOW=' .env; then
    sed -i "s|^DB_MAX_OVERFLOW=.*|DB_MAX_OVERFLOW=${DB_MAX_OVERFLOW}|" .env
  else
    echo "DB_MAX_OVERFLOW=${DB_MAX_OVERFLOW}" >> .env
  fi
  if grep -qE '^DB_POOL_TIMEOUT=' .env; then
    sed -i "s|^DB_POOL_TIMEOUT=.*|DB_POOL_TIMEOUT=${DB_POOL_TIMEOUT}|" .env
  else
    echo "DB_POOL_TIMEOUT=${DB_POOL_TIMEOUT}" >> .env
  fi
  if grep -qE '^DB_POOL_RECYCLE=' .env; then
    sed -i "s|^DB_POOL_RECYCLE=.*|DB_POOL_RECYCLE=${DB_POOL_RECYCLE}|" .env
  else
    echo "DB_POOL_RECYCLE=${DB_POOL_RECYCLE}" >> .env
  fi
  if [[ -x "scripts/env_validate.sh" ]]; then
    bash scripts/env_validate.sh --strict --env .env
  fi
  chmod 600 .env
}

check_system() {
  step "System checks"
  [ "$(id -u)" -eq 0 ] || error "Please run as root"

  [[ -f /etc/os-release ]] || error "/etc/os-release not found; unsupported Linux distribution"
  # shellcheck disable=SC1091
  source /etc/os-release
  OS_ID="${ID:-}"
  OS_VERSION_ID="${VERSION_ID:-}"
  OS_VERSION_CODENAME="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
  OS_ID_LIKE="${ID_LIKE:-}"

  command -v apt-get >/dev/null 2>&1 || error "This installer currently supports apt-based Linux distributions only (Debian/Ubuntu/Zorin/etc.)"
  command -v systemctl >/dev/null 2>&1 || error "systemd is required"
  case " ${OS_ID} ${OS_ID_LIKE} " in
    *" debian "*|*" ubuntu "*) ;;
    *) warn "Untested apt-based distribution: ${PRETTY_NAME:-${OS_ID} ${OS_VERSION_ID}}. Debian/Ubuntu/Zorin are the supported targets." ;;
  esac
  info "Detected OS: ${PRETTY_NAME:-${OS_ID} ${OS_VERSION_ID}}"

  MEM=$(free -m | awk '/^Mem:/{print $2}')
  info "Memory: ${MEM}MB"
  [ "$MEM" -lt 1500 ] && warn "Memory is below 1.5GB; stability may be affected"

  success "System checks passed"
}

configure_package_repos() {
  step "Prepare package manager"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  APT_FRONTEND_READY=1
  success "Package manager ready (existing distribution repositories preserved)"
}

upgrade_system_packages() {
  if [[ "${UPGRADE_SYSTEM}" != "1" ]]; then
    info "Skipping system package upgrade (use --upgrade-system to enable)"
    return
  fi
  step "Upgrade system packages"
  export DEBIAN_FRONTEND=noninteractive
  [[ "$APT_FRONTEND_READY" -eq 1 ]] || apt-get update -qq
  apt-get -y -qq upgrade
  if [[ -f /var/run/reboot-required ]]; then
    warn "A reboot is required after package upgrade."
    warn "Please reboot and rerun installer: bash install.sh --run-local"
    exit 1
  fi
  success "System package upgrade completed"
}

install_deps() {
  step "Install system dependencies"
  apt install -y -qq \
    curl wget git unzip build-essential \
    ca-certificates gnupg lsb-release sudo \
    openssl htop vim ufw fail2ban \
    python3 python3-venv python3-pip \
    libpq-dev libssl-dev libffi-dev
  PYTHON_BIN="$(command -v python3.12 || true)"
  if [[ -z "${PYTHON_BIN}" && -x /opt/python-3.12.15/bin/python3.12 ]]; then
    PYTHON_BIN=/opt/python-3.12.15/bin/python3.12
  fi
  [[ -n "${PYTHON_BIN}" ]] || error "Python 3.12 is required for the locked API dependencies"
  [[ -n "$PYTHON_BIN" ]] || error "Python 3 not found after dependency installation"
  success "System dependencies installed"
}

install_postgres() {
  step "Install PostgreSQL"
  mkdir -p /etc/apt/keyrings
  local pgdg_codename="${OS_VERSION_CODENAME}"
  if [[ -n "$pgdg_codename" ]]; then
    if [ ! -f /etc/apt/keyrings/postgresql.gpg ]; then
      curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | \
        gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg
    fi
    echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt ${pgdg_codename}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    if apt-get update -qq && apt-cache show postgresql-16 >/dev/null 2>&1; then
      apt install -y -qq postgresql-16
    else
      warn "PostgreSQL PGDG repo is unavailable for codename '${pgdg_codename}'; falling back to distribution PostgreSQL package"
      rm -f /etc/apt/sources.list.d/pgdg.list
      apt-get update -qq
      apt install -y -qq postgresql
    fi
  else
    warn "Could not detect distribution codename; installing distribution PostgreSQL package"
    apt install -y -qq postgresql
  fi

  systemctl enable postgresql
  systemctl start postgresql
  POSTGRES_VERSION="$(psql -V | awk '{print $3}' | cut -d. -f1)"
  [[ -n "$POSTGRES_VERSION" ]] || error "Could not detect installed PostgreSQL version"

  # Idempotent role/database setup with strict error checking.
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${APP_USER}'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 \
      -c "CREATE ROLE \"${APP_USER}\" WITH LOGIN PASSWORD '${DB_PASS_SQL_ESCAPED}';"
  fi
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE \"${APP_USER}\" WITH LOGIN PASSWORD '${DB_PASS_SQL_ESCAPED}';"

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${APP_USER}'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 \
      -c "CREATE DATABASE \"${APP_USER}\" OWNER \"${APP_USER}\";"
  fi
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \
    -c "GRANT ALL PRIVILEGES ON DATABASE \"${APP_USER}\" TO \"${APP_USER}\";"

  # Dynamic memory tuning based on total RAM.
  PG_CONF="/etc/postgresql/${POSTGRES_VERSION}/main/postgresql.conf"
  TOTAL_MEM_MB="$(free -m | awk '/^Mem:/{print $2}')"
  SHARED_MB=$(( TOTAL_MEM_MB / 4 ))
  EFFECTIVE_MB=$(( TOTAL_MEM_MB * 3 / 4 ))
  WORK_MB=$(( TOTAL_MEM_MB / 64 ))
  (( SHARED_MB < 64 )) && SHARED_MB=64
  (( WORK_MB < 4 )) && WORK_MB=4
  (( WORK_MB > 64 )) && WORK_MB=64
  if [[ -f "$PG_CONF" ]]; then
    sed -i "s|#shared_buffers = 128MB|shared_buffers = ${SHARED_MB}MB|" "$PG_CONF"
    sed -i "s|#work_mem = 4MB|work_mem = ${WORK_MB}MB|" "$PG_CONF"
    sed -i "s|#maintenance_work_mem = 64MB|maintenance_work_mem = 64MB|" "$PG_CONF"
    sed -i "s|#effective_cache_size = 4GB|effective_cache_size = ${EFFECTIVE_MB}MB|" "$PG_CONF"
    systemctl restart postgresql
  else
    warn "PostgreSQL config not found at ${PG_CONF}; skipping memory tuning"
  fi

  # Verify that password auth really works before continuing.
  PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -U "${APP_USER}" -d "${APP_USER}" \
    -c "SELECT 1;" >/dev/null 2>&1 || error "PostgreSQL login check failed for user ${APP_USER}"

  success "PostgreSQL ${POSTGRES_VERSION} installed, database: ${APP_USER}"
}

install_redis() {
  step "Install Redis 7"
  apt install -y -qq redis-server

  REDIS_CONF="/etc/redis/redis.conf"
  sed -i "s|# requirepass foobared|requirepass ${REDIS_PASS}|" "$REDIS_CONF"
  sed -i "s|# maxmemory <bytes>|maxmemory 256mb|" "$REDIS_CONF"
  sed -i "s|# maxmemory-policy noeviction|maxmemory-policy allkeys-lru|" "$REDIS_CONF"
  # Bind Redis to localhost only.
  sed -i "s|^bind 127.0.0.1 ::1|bind 127.0.0.1|" "$REDIS_CONF"

  systemctl enable redis-server
  systemctl restart redis-server
  success "Redis 7 installed"
}

install_prosody() {
  step "Install Prosody XMPP server"
  apt install -y -qq prosody prosody-modules lua-dbi-postgresql mercurial
  usermod -aG prosody "${APP_USER}" || true

  # Install prosody-modules (community modules) for mod_cloud_notify
  if [ ! -f /usr/lib/prosody/modules/mod_smacks/mod_smacks.lua ]; then
    hg clone https://hg.prosody.im/prosody-modules /usr/lib/prosody-modules 2>/dev/null \
      || warn "Could not clone prosody-modules; mod_cloud_notify may be unavailable"
  fi

  cp configs/prosody/prosody.cfg.lua /etc/prosody/prosody.cfg.lua
  sed -i "s|XMPP_DOMAIN|${XMPP_DOMAIN}|g" /etc/prosody/prosody.cfg.lua

  # Restrict CORS to the actual frontend origin instead of "*". DOMAIN here is
  # the public hostname of the web app; if you front-end Lyao Talk on a
  # different host, set LIAOT_FRONTEND_ORIGIN before running install.sh.
  XMPP_FRONTEND_ORIGIN="${LIAOT_FRONTEND_ORIGIN:-https://${DOMAIN}}"
  sed -i "s|XMPP_FRONTEND_ORIGIN|${XMPP_FRONTEND_ORIGIN}|g" /etc/prosody/prosody.cfg.lua

  # Generate DH params for TLS forward secrecy. 2048-bit takes ~10s, only
  # done on first install. Without these, the `ssl.dhparam` directive in
  # prosody.cfg.lua references a file that doesn't exist and Prosody
  # falls back to compiled-in defaults (small / shared / weak).
  mkdir -p /etc/prosody/certs
  if [ ! -f /etc/prosody/certs/dh-2048.pem ]; then
    info "Generating DH parameters for Prosody TLS (one-time, ~10s)..."
    if [[ -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
      install -m 0640 -o root -g prosody /etc/letsencrypt/ssl-dhparams.pem /etc/prosody/certs/dh-2048.pem \
        || warn "Could not install /etc/prosody/certs/dh-2048.pem"
    else
      openssl dhparam -out /etc/prosody/certs/dh-2048.pem 2048 >/dev/null 2>&1 \
        || warn "openssl dhparam failed; Prosody will use compiled-in DH params"
    fi
    chown prosody:prosody /etc/prosody/certs/dh-2048.pem 2>/dev/null || true
    chmod 640 /etc/prosody/certs/dh-2048.pem 2>/dev/null || true
  fi

  # The template pins Prosody's TLS certificate paths so c2s/s2s always serve
  # a predictable certificate. On a clean install Let's Encrypt is issued later
  # by setup_ssl(), so create a short-lived self-signed placeholder first.
  # configure_prosody_tls() replaces it with the real certificate after ACME.
  local prosody_cert_dir="/etc/prosody/certs/${XMPP_DOMAIN}"
  mkdir -p "${prosody_cert_dir}"
  if [[ ! -f "${prosody_cert_dir}/fullchain.pem" || ! -f "${prosody_cert_dir}/privkey.pem" ]]; then
    info "Generating temporary Prosody TLS certificate for ${XMPP_DOMAIN}"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -days 7 -subj "/CN=${XMPP_DOMAIN}" \
      -keyout "${prosody_cert_dir}/privkey.pem" \
      -out "${prosody_cert_dir}/fullchain.pem" >/dev/null 2>&1 \
      || warn "Could not generate temporary Prosody TLS certificate"
    chown root:prosody "${prosody_cert_dir}/fullchain.pem" "${prosody_cert_dir}/privkey.pem" 2>/dev/null || true
    chmod 644 "${prosody_cert_dir}/fullchain.pem" 2>/dev/null || true
    chmod 640 "${prosody_cert_dir}/privkey.pem" 2>/dev/null || true
  fi

  # Inject TURN secret if coturn was installed
  if [ -n "${TURN_SECRET:-}" ]; then
    sed -i "s|TURN_SECRET_PLACEHOLDER|${TURN_SECRET}|g" /etc/prosody/prosody.cfg.lua
  fi

  # Install Lyao Talk push relay module
  mkdir -p /usr/lib/prosody-modules/mod_liaot_push
  cp configs/prosody/mod_liaot_push.lua /usr/lib/prosody-modules/mod_liaot_push/mod_liaot_push.lua

  # Inject PUSH_SHARED_SECRET into prosody config
  if [ -n "${PUSH_SHARED_SECRET:-}" ]; then
    sed -i "s|PUSH_SHARED_SECRET_PLACEHOLDER|${PUSH_SHARED_SECRET}|g" /etc/prosody/prosody.cfg.lua
  fi

  # Tell Prosody where to find community modules
  if ! grep -q "plugin_paths" /etc/prosody/prosody.cfg.lua; then
    sed -i "1i plugin_paths = { \"/usr/lib/prosody-modules\" }" /etc/prosody/prosody.cfg.lua
  fi

  prosodyctl check config 2>/dev/null || true

  install -d -m 755 /usr/local/lib/liaot
  install -m 644 configs/prosody/liaot_registration_helper.py /usr/local/lib/liaot/liaot_registration_helper.py
  cat > /etc/systemd/system/liaot-prosody.socket <<EOF
[Unit]
Description=Lyao Talk Prosody registration socket
[Socket]
ListenStream=/run/liaot-prosody.sock
SocketUser=prosody
SocketGroup=${APP_USER}
SocketMode=0660
RemoveOnStop=yes
[Install]
WantedBy=sockets.target
EOF
  cat > /etc/systemd/system/liaot-prosody.service <<EOF
[Unit]
Description=Lyao Talk Prosody registration helper
Requires=liaot-prosody.socket
After=prosody.service
[Service]
Type=simple
User=prosody
Group=prosody
Environment=LIAOT_XMPP_DOMAIN=${XMPP_DOMAIN}
ExecStart=/usr/bin/python3 /usr/local/lib/liaot/liaot_registration_helper.py
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/prosody
PrivateTmp=true
EOF
  systemctl daemon-reload
  systemctl enable --now liaot-prosody.socket

  systemctl enable prosody
  systemctl restart prosody

  XMPP_ADMIN_JID="${XMPP_ADMIN_USER}@${XMPP_DOMAIN}"
  if prosodyctl register "${XMPP_ADMIN_USER}" "${XMPP_DOMAIN}" "${XMPP_ADMIN_PASS}" >/tmp/liaot-prosody-admin.log 2>&1; then
    XMPP_ADMIN_CREATED=1
  else
    if grep -Eiq "exists|already" /tmp/liaot-prosody-admin.log; then
      warn "Default account ${XMPP_ADMIN_JID} already exists; keeping existing password"
      XMPP_ADMIN_CREATED=0
    else
      cat /tmp/liaot-prosody-admin.log >&2 || true
      error "Failed to create default XMPP admin account: ${XMPP_ADMIN_JID}"
    fi
  fi
  success "Prosody installed, domain: ${XMPP_DOMAIN}"
}

install_coturn() {
  step "Install coturn STUN/TURN server (for Jingle audio/video calls)"
  apt install -y -qq coturn

  TURN_SECRET="${TURN_SECRET:-$(openssl rand -hex 32)}"
  LDAP_URL="${LDAP_URL:-${LDAP_SERVER:-}}"
  PROMETHEUS_ALLOW_CIDR="${PROMETHEUS_ALLOW_CIDR:-}"

  cat > /etc/turnserver.conf <<EOF
# Lyao Talk coturn config (auto-generated)
listening-port=3478
tls-listening-port=5349

fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}

realm=${DOMAIN}
server-name=turn.${DOMAIN}

# Use Let's Encrypt cert (renewed by certbot)
cert=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem
pkey=/etc/letsencrypt/live/${DOMAIN}/privkey.pem

# Limit relay range - prevents abuse
min-port=49152
max-port=65535

# No anonymous relay
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1

# Logging
log-file=/var/log/coturn.log
verbose
EOF

  # TURN_SECRET is generated in load_config, persisted to .env, injected into
  # Prosody during install_prosody, and written to the API EnvironmentFile during
  # deploy_api. Do not append here: deploy_api owns ${INSTALL_DIR}/api/.env and
  # duplicates can make systemd EnvironmentFile resolution ambiguous.

  systemctl enable coturn
  systemctl restart coturn
  success "coturn installed (TURN secret saved to api/.env)"
}

install_minio() {
  step "Install MinIO object storage"
  systemctl stop minio 2>/dev/null || true
  pkill -f '/usr/local/bin/minio' 2>/dev/null || true
  sleep 1
  wget -q https://dl.min.io/server/minio/release/linux-amd64/minio -O /tmp/minio.new
  install -m 755 /tmp/minio.new /usr/local/bin/minio
  rm -f /tmp/minio.new

  mkdir -p /data/minio
  chown -R "${MINIO_USER}:${MINIO_USER}" /data/minio

  cat > /etc/systemd/system/minio.service << EOF
[Unit]
Description=MinIO Object Storage
After=network.target

[Service]
User=${MINIO_USER}
Group=${MINIO_USER}
Environment="MINIO_ROOT_USER=${MINIO_ROOT_USER}"
Environment="MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}"
Environment="MINIO_VOLUMES=/data/minio"
ExecStart=/usr/local/bin/minio server /data/minio --console-address "127.0.0.1:9001" --address "127.0.0.1:9000"
Restart=always
RestartSec=5
LimitNOFILE=65536

# Sandbox hardening — same rationale as liaot-api: an RCE in MinIO
# (Go binary; not impossible) without sandboxing means immediate access
# to any other tenant on the same host. /data/minio is the only writable
# path; everything else read-only.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ReadWritePaths=/data/minio

CapabilityBoundingSet=
AmbientCapabilities=

RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
# MinIO is Go and uses some calls that simple SystemCallFilter=@system-service
# would block (it manages its own goroutine threading). Stick to a coarse
# exclusion list rather than an allowlist.
SystemCallFilter=~@privileged @debug @mount @reboot @swap @raw-io
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable minio
  systemctl start minio

  sleep 3

  wget -q https://dl.min.io/client/mc/release/linux-amd64/mc \
    -O /usr/local/bin/mc
  chmod +x /usr/local/bin/mc
  /usr/local/bin/mc alias set local http://127.0.0.1:9000 \
    "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" --quiet 2>/dev/null || true
  /usr/local/bin/mc mb local/liaot-files --quiet 2>/dev/null || true
  /usr/local/bin/mc anonymous set none local/liaot-files --quiet 2>/dev/null || true

  success "MinIO installed, bucket: liaot-files"
}

install_nodejs() {
  step "Install Node.js"
  local current_major=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$current_major" =~ ^[0-9]+$ ]] && (( current_major >= 20 )); then
      success "Node.js $(node --version) already installed"
      return
    fi
  fi

  if curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1; then
    apt install -y -qq nodejs
  else
    warn "NodeSource setup failed; trying distribution nodejs/npm packages"
    apt install -y -qq nodejs npm
  fi

  command -v node >/dev/null 2>&1 || error "Node.js installation failed"
  current_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if ! [[ "$current_major" =~ ^[0-9]+$ ]] || (( current_major < 20 )); then
    error "Node.js 20+ is required, installed: $(node --version)"
  fi
  success "Node.js $(node --version) installed"
}

deploy_api() {
  step "Deploy FastAPI backend"
  PYTHON_BIN="${PYTHON_BIN:-$(command -v python3.12 || true)}"
  [[ -n "${PYTHON_BIN}" ]] || error "Python 3.12 is required for the locked API dependencies"
  [[ -n "$PYTHON_BIN" ]] || error "Python 3 is required"
  mkdir -p "${INSTALL_DIR}"
  rm -rf "${INSTALL_DIR}/api"
  cp -r "${SRC_DIR}/apps/api" "${INSTALL_DIR}/api"
  [[ -f "${SRC_DIR}/VERSION" ]] && cp "${SRC_DIR}/VERSION" "${INSTALL_DIR}/api/VERSION"
  chown -R "${APP_USER}:${APP_USER}" "${INSTALL_DIR}/api"

  cd "${INSTALL_DIR}/api"
  "${PYTHON_BIN}" -m venv .venv
  .venv/bin/pip install -q --upgrade pip

  # Install LDAP system libraries if LDAP is enabled (needed by ldap3 TLS)
  if [ "${LDAP_ENABLED:-false}" = "true" ]; then
    log "LDAP enabled — installing system libraries (libldap2-dev, libsasl2-dev)..."
    apt-get install -y -q libldap2-dev libsasl2-dev >/dev/null 2>&1 || true
  fi

  .venv/bin/pip install -q --require-hashes -r requirements.txt

  # Generate VAPID keypair for Web Push (PWA notifications)
  if [ -z "${VAPID_PRIVATE_KEY:-}" ]; then
    VAPID_PEM_FILE="$(mktemp)"
    openssl ecparam -name prime256v1 -genkey -noout -out "$VAPID_PEM_FILE" 2>/dev/null
    VAPID_PRIVATE_KEY="$(openssl pkey -in "$VAPID_PEM_FILE" -outform DER 2>/dev/null \
        | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=' | tr -d '\n')"
    VAPID_PUBLIC_KEY="$(openssl ec -in "$VAPID_PEM_FILE" -pubout -outform DER 2>/dev/null \
        | tail -c 65 | base64 | tr '+/' '-_' | tr -d '=' | tr -d '\n')"
    rm -f "$VAPID_PEM_FILE"
  fi
  PUSH_SHARED_SECRET="${PUSH_SHARED_SECRET:-$(openssl rand -hex 24)}"

  if [[ -z "${ADMIN_PASS_HASH:-}" && -n "${ADMIN_PASS:-}" ]]; then
    ADMIN_PASS_HASH="$(.venv/bin/python -c "from argon2 import PasswordHasher; import sys; print(PasswordHasher().hash(sys.argv[1]))" "${ADMIN_PASS}")"
  fi
  [[ -n "${ADMIN_PASS_HASH:-}" ]] || error "ADMIN_PASS_HASH is empty. Run scripts/env_wizard.sh or set ADMIN_PASS_HASH in .env."

  cat > "${INSTALL_DIR}/api/.env" << EOF
DATABASE_URL=postgresql+asyncpg://${APP_USER}:${DB_PASS_URLENCODED}@127.0.0.1:5432/${APP_USER}
REDIS_URL=redis://:${REDIS_PASS}@127.0.0.1:6379/0
MINIO_ENDPOINT=127.0.0.1:9000
MINIO_ACCESS_KEY=${MINIO_ROOT_USER}
MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD}
MINIO_BUCKET=liaot-files
MINIO_SECURE=false
SECRET_KEY=${SECRET_KEY}
CORS_ORIGINS=["https://${DOMAIN}"]
XMPP_DOMAIN=${XMPP_DOMAIN}
XMPP_REGISTRATION_ENABLED=true
PUBLIC_DOMAIN=${PUBLIC_DOMAIN}
ADMIN_USER=${ADMIN_USER}
ADMIN_PASS_HASH=${ADMIN_PASS_HASH}
AI_API_KEY=${AI_API_KEY}
AI_BASE_URL=${AI_BASE_URL}
AI_MODEL=${AI_MODEL}
ALERT_EMAIL=${ALERT_EMAIL}
DB_POOL_SIZE=${DB_POOL_SIZE}
DB_MAX_OVERFLOW=${DB_MAX_OVERFLOW}
DB_POOL_TIMEOUT=${DB_POOL_TIMEOUT}
DB_POOL_RECYCLE=${DB_POOL_RECYCLE}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_EMAIL=admin@${DOMAIN}
PUSH_SHARED_SECRET=${PUSH_SHARED_SECRET}
TURN_SECRET=${TURN_SECRET}
FRONTEND_URL=${FRONTEND_URL:-https://${DOMAIN}}
OIDC_ENABLED=${OIDC_ENABLED:-false}
OIDC_ISSUER=${OIDC_ISSUER:-}
OIDC_CLIENT_ID=${OIDC_CLIENT_ID:-}
OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET:-}
OIDC_REDIRECT_URI=${OIDC_REDIRECT_URI:-https://${DOMAIN}/sso/oidc/callback}
OIDC_LABEL="${OIDC_LABEL:-Single Sign-On}"
OIDC_REQUIRE_EMAIL_VERIFIED=${OIDC_REQUIRE_EMAIL_VERIFIED:-true}
AUTO_PROVISION_OIDC=${AUTO_PROVISION_OIDC:-false}
LDAP_ENABLED=${LDAP_ENABLED:-false}
LDAP_SERVER=${LDAP_SERVER:-${LDAP_URL:-}}
LDAP_BIND_DN_TEMPLATE="${LDAP_BIND_DN_TEMPLATE:-uid={username},ou=People,dc=example,dc=com}"
LDAP_LABEL="${LDAP_LABEL:-Corporate Login}"
AUTO_PROVISION_LDAP=${AUTO_PROVISION_LDAP:-false}
LOG_LEVEL=${LOG_LEVEL:-INFO}
LOG_FORMAT=${LOG_FORMAT:-json}
METRICS_ENABLED=${METRICS_ENABLED:-true}
PERF_QUERY_COUNT_ENABLED=${PERF_QUERY_COUNT_ENABLED:-true}
PERF_QUERY_WARN_THRESHOLD=${PERF_QUERY_WARN_THRESHOLD:-10}
PERF_SLOW_SQL_MS=${PERF_SLOW_SQL_MS:-250}
SFU_URL=${SFU_URL:-}
EOF
  chmod 600 "${INSTALL_DIR}/api/.env"
  chown "${APP_USER}:${APP_USER}" "${INSTALL_DIR}/api/.env"

  # Alembic uses alembic.ini sqlalchemy.url (not app .env), keep them in sync.
  sed -i "s|^sqlalchemy.url = .*|sqlalchemy.url = postgresql+asyncpg://${APP_USER}:${DB_PASS_URLENCODED}@127.0.0.1:5432/${APP_USER}|" \
    "${INSTALL_DIR}/api/alembic.ini"

  # Run database migrations.
  cd "${INSTALL_DIR}/api"
  DB_HAS_ACCOUNTS="$(
    PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -U "${APP_USER}" -d "${APP_USER}" -tAc \
      "SELECT CASE WHEN to_regclass('public.accounts') IS NULL THEN '0' ELSE '1' END;" 2>/dev/null || echo "0"
  )"
  DB_HAS_ALEMBIC="$(
    PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -U "${APP_USER}" -d "${APP_USER}" -tAc \
      "SELECT CASE WHEN to_regclass('public.alembic_version') IS NULL THEN '0' ELSE '1' END;" 2>/dev/null || echo "0"
  )"

  if [[ "${DB_HAS_ACCOUNTS}" = "1" && "${DB_HAS_ALEMBIC}" = "0" ]]; then
    warn "Detected existing schema without alembic version table, stamping to head..."
    .venv/bin/alembic stamp head
  fi
  .venv/bin/alembic upgrade head

  NPROC="$(nproc || echo 1)"
  UVICORN_WORKERS=$(( NPROC * 2 + 1 ))
  (( UVICORN_WORKERS > 8 )) && UVICORN_WORKERS=8
  (( UVICORN_WORKERS < 2 )) && UVICORN_WORKERS=2
  cat > /etc/systemd/system/liaot-api.service << EOF
[Unit]
Description=Lyao Talk FastAPI Backend
After=network.target postgresql.service redis.service
Requires=postgresql.service

[Service]
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}/api
EnvironmentFile=${INSTALL_DIR}/api/.env
Environment=HOME=${INSTALL_DIR}/api
ExecStart=${INSTALL_DIR}/api/.venv/bin/uvicorn app.main:app \\
    --host 127.0.0.1 \\
    --port 8000 \\
    --workers ${UVICORN_WORKERS} \\
    --log-level info
Restart=always
RestartSec=5

# ==========================================================================
# Sandbox hardening — defense-in-depth against RCE-style exploits.
#
# If an attacker manages remote code execution inside the FastAPI worker
# (via a future 0-day in some dependency, an unpatched route handler, etc.),
# without these directives they would inherit the full liaot user's
# privileges: read .env (DB password, JWT secret, MinIO root credentials,
# AI provider key), bind any socket, ptrace siblings, read /proc, write
# anywhere the user can write.
#
# Each directive below is annotated with what it blocks. We test on every
# release to make sure these don't break legitimate functionality (e.g.,
# we DO need access to /tmp for SpooledTemporaryFile during multipart
# uploads, hence PrivateTmp=yes which gives us our OWN /tmp).
# ==========================================================================

# Filesystem isolation. Prosody registration uses a dedicated Unix socket.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
# We need to write to: install_dir (for runtime cache), /var/log/liaot
# (for app log), and the standard journald socket (handled outside FS).
# Everything else on the FS is read-only.
ReadWritePaths=${INSTALL_DIR} /var/log/liaot

# The API needs no elevated Linux capabilities.
CapabilityBoundingSet=
AmbientCapabilities=

# Network restriction — uvicorn binds AF_INET (IPv4) only. We don't use
# AF_PACKET, AF_NETLINK, AF_UNIX (except for journald which is allowed
# implicitly), and definitely not the more exotic ones.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
IPAddressAllow=127.0.0.0/8
IPAddressAllow=::1/128
# Allow outbound to any IP for AI provider, OIDC IdP, push services, etc.
# (Without this, IPAddressDeny=any would block all egress including localhost.
#  We allow loopback explicitly above; for outbound HTTPS we need any-IP egress.)
IPAddressAllow=any

# Process / namespace isolation
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native

# System call filtering — block the obviously-not-needed call families.
# @system-service is systemd's curated allowlist of calls a typical service
# legitimately uses; @privileged, @raw-io, @reboot, @swap, @debug, @mount,
# @cpu-emulation, @obsolete are all explicitly removed.
SystemCallFilter=
SystemCallErrorNumber=EPERM

# Resource limits — backstop against memory-exhaustion bugs
LimitNOFILE=65536
LimitNPROC=512
TasksMax=1024

[Install]
WantedBy=multi-user.target
EOF

  # Ensure the log directory exists with appropriate permissions
  mkdir -p /var/log/liaot
  chown ${APP_USER}:${APP_USER} /var/log/liaot
  chmod 750 /var/log/liaot

  systemctl daemon-reload
  systemctl enable liaot-api
  systemctl start liaot-api
  sleep 2

  cd "${SRC_DIR}"
  success "FastAPI backend deployed, listening on 127.0.0.1:8000"
}

deploy_frontend() {
  step "Build frontend (React + Vite)"
  rm -rf "${INSTALL_DIR}/web"
  cp -r "${SRC_DIR}/apps/web" "${INSTALL_DIR}/web"
  cd "${INSTALL_DIR}/web"

  cat > .env.production << EOF
VITE_API_URL=https://${DOMAIN}/api
VITE_XMPP_WS_URL=wss://${DOMAIN}/xmpp-websocket
VITE_XMPP_DOMAIN=${XMPP_DOMAIN}
EOF

  if [[ -f package-lock.json ]]; then
    npm ci --silent
  else
    # NEVER fall back to `npm install` in production. Without a lockfile,
    # npm resolves caret-pinned ranges (e.g., axios "^1.15.0") to whatever
    # the latest matching version is at install time — exactly the path
    # that the March 2026 axios 1.14.1 supply chain compromise exploited.
    # Force the operator to commit/copy a vetted lockfile before retrying.
    error "package-lock.json missing — refusing to run 'npm install' without a lockfile (supply-chain risk). Commit/copy a vetted package-lock.json and retry."
  fi
  npm run build

  FRONTEND_DIST="${INSTALL_DIR}/web/dist"
  chmod -R a+rX "${FRONTEND_DIST}" || true
  cd "${SRC_DIR}"
  success "Frontend build completed, output: ${FRONTEND_DIST}"
}

install_nginx() {
  step "Install and configure Nginx"
  apt install -y -qq nginx

  # Temporary HTTP config for certbot validation.
  cat > /etc/nginx/sites-available/liaot << EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    root ${INSTALL_DIR}/web/dist;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

  ln -sf /etc/nginx/sites-available/liaot /etc/nginx/sites-enabled/liaot
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl restart nginx
  success "Nginx temporary config completed"
}

setup_ssl() {
  step "Issue Let's Encrypt SSL certificate"
  apt install -y -qq certbot python3-certbot-nginx

  local cert_dir="/etc/letsencrypt/live/${DOMAIN}"
  local cert_fullchain="${cert_dir}/fullchain.pem"
  local cert_privkey="${cert_dir}/privkey.pem"
  local has_usable_cert=0
  if [[ -f "$cert_fullchain" && -f "$cert_privkey" ]]; then
    if openssl x509 -checkend 86400 -noout -in "$cert_fullchain" >/dev/null 2>&1; then
      has_usable_cert=1
      info "Usable certificate detected, skipping re-issuance"
    fi
  fi

  if [[ "$has_usable_cert" -eq 0 ]]; then
    certbot certonly --nginx \
      -d "${DOMAIN}" \
      --email "${EMAIL}" \
      --agree-tos \
      --non-interactive
    success "SSL certificate issued successfully"
  fi

  cp configs/nginx/liaot.conf /etc/nginx/sites-available/liaot
  sed -i "s|DOMAIN|${DOMAIN}|g" /etc/nginx/sites-available/liaot
  sed -i "s|INSTALL_DIR|${INSTALL_DIR}|g" /etc/nginx/sites-available/liaot
  if [[ -n "${PROMETHEUS_ALLOW_CIDR:-}" ]]; then
    sed -i "/location = \/api\/metrics {/,/deny all;/ s|deny all;|allow ${PROMETHEUS_ALLOW_CIDR};\n        deny all;|" /etc/nginx/sites-available/liaot
  fi
  cat > /etc/nginx/conf.d/liaot-rate-limit.conf << 'EOF'
# Lyao Talk rate-limit and connection-limit zones.
# Referenced by /etc/nginx/sites-available/liaot. If you change zone
# names here, update the conf to match.
#
# Sizes:
#   - 10m of zone state stores ~160k unique source IPs (each entry is 64
#     bytes for the binary IP + counters). Plenty for any single host.
#
# Rates:
#   - api_auth (30r/m):  tight on credential endpoints. A real user fixing
#                        a typo retries within burst=10; brute force gets 429.
#   - api_general (300r/m): loose on data endpoints. A typical chat session
#                        does ~20 requests on initial load, then tapers.
#                        300/min is comfortable for legit use, hard for
#                        scrapers/spammers.
#   - conn_per_ip:       slowloris defense — caps concurrent connections
#                        per IP. Tied to limit_conn directive in the vhost.
limit_req_zone $binary_remote_addr zone=api_auth:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=api_general:10m rate=300r/m;
limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;
EOF

  nginx -t && systemctl reload nginx
  success "Nginx HTTPS configuration completed"

  systemctl enable certbot.timer
  systemctl start certbot.timer
}

configure_prosody_tls() {
  step "Configure Prosody TLS certificate"

  local cert_dir="/etc/letsencrypt/live/${DOMAIN}"
  local cert_fullchain="${cert_dir}/fullchain.pem"
  local cert_privkey="${cert_dir}/privkey.pem"
  local prosody_cert_dir="/etc/prosody/certs/${XMPP_DOMAIN}"

  if [[ ! -f "$cert_fullchain" || ! -f "$cert_privkey" ]]; then
    warn "Let's Encrypt certificate not found for ${DOMAIN}; skipping Prosody TLS copy"
    return 0
  fi

  mkdir -p "$prosody_cert_dir"
  install -m 0644 -o root -g prosody "$cert_fullchain" "${prosody_cert_dir}/fullchain.pem"
  install -m 0640 -o root -g prosody "$cert_privkey" "${prosody_cert_dir}/privkey.pem"

  if systemctl is-active --quiet prosody; then
    systemctl restart prosody
  fi
  success "Prosody TLS certificate configured"
}

setup_firewall() {
  detect_ssh_ports() {
    local ports=""
    if command -v ss >/dev/null 2>&1; then
      ports="$(ss -H -tnlp 2>/dev/null | awk '/sshd/ {split($4,a,":"); p=a[length(a)]; if (p ~ /^[0-9]+$/) print p}' | sort -n | uniq | paste -sd' ' -)"
    fi
    if [[ -z "$ports" ]]; then
      ports="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/ {print $2}' /etc/ssh/sshd_config 2>/dev/null | sort -n | uniq | paste -sd' ' -)"
    fi
    if [[ -z "$ports" ]] && compgen -G "/etc/ssh/sshd_config.d/*.conf" >/dev/null; then
      ports="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/ {print $2}' /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sort -n | uniq | paste -sd' ' -)"
    fi
    if [[ -z "$ports" ]]; then
      ports="22"
    fi
    echo "$ports"
  }

  validate_port() {
    local p="$1"
    [[ "$p" =~ ^[0-9]+$ ]] || return 1
    (( p >= 1 && p <= 65535 ))
  }

  prompt_yes_no() {
    local prompt="$1"
    local default_no="${2:-1}"
    local reply=""
    if [[ -r /dev/tty ]]; then
      if [[ "$default_no" -eq 1 ]]; then
        read -r -p "${prompt} [yes/NO]: " reply < /dev/tty
      else
        read -r -p "${prompt} [YES/no]: " reply < /dev/tty
      fi
    elif [[ -t 0 ]]; then
      if [[ "$default_no" -eq 1 ]]; then
        read -r -p "${prompt} [yes/NO]: " reply
      else
        read -r -p "${prompt} [YES/no]: " reply
      fi
    else
      warn "Non-interactive session detected. Defaulting to no: ${prompt}"
      return 1
    fi
    reply="${reply// /}"
    [[ "${reply,,}" == "yes" ]]
  }

  prompt_input() {
    local prompt="$1"
    local reply=""
    if [[ -r /dev/tty ]]; then
      read -r -p "${prompt}" reply < /dev/tty
    elif [[ -t 0 ]]; then
      read -r -p "${prompt}" reply
    else
      return 1
    fi
    echo "$reply"
  }

  apply_sshd_dropin_and_reload() {
    mkdir -p /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/99-liaot-auth.conf <<'EOF'
PasswordAuthentication yes
PubkeyAuthentication yes
EOF

    if command -v sshd >/dev/null 2>&1; then
      sshd -t
    elif [[ -x /usr/sbin/sshd ]]; then
      /usr/sbin/sshd -t
    else
      error "sshd binary not found, cannot validate SSH config"
    fi

    systemctl reload ssh 2>/dev/null || \
    systemctl reload sshd 2>/dev/null || \
    systemctl restart ssh 2>/dev/null || \
    systemctl restart sshd 2>/dev/null || \
    error "failed to reload ssh service"
  }

  apply_sshd_port() {
    local new_port="$1"
    mkdir -p /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/99-liaot-port.conf <<EOF
Port ${new_port}
EOF
    apply_sshd_dropin_and_reload
  }

  detect_or_create_local_public_key() {
    local ssh_dir="${HOME}/.ssh"
    local priv=""
    local pub=""
    mkdir -p "$ssh_dir"
    chmod 700 "$ssh_dir"

    if [[ -n "${SSH_AUTH_SOCK:-}" ]] && command -v ssh-add >/dev/null 2>&1; then
      local agent_key
      agent_key="$(ssh-add -L 2>/dev/null | awk '/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)/ {print; exit}' || true)"
      if [[ -n "$agent_key" ]]; then
        echo "$agent_key"
        return 0
      fi
    fi

    for priv in "$ssh_dir/id_ed25519" "$ssh_dir/id_ecdsa" "$ssh_dir/id_rsa"; do
      if [[ -f "$priv" ]]; then
        pub="${priv}.pub"
        if [[ ! -f "$pub" ]]; then
          ssh-keygen -y -f "$priv" > "$pub"
          chmod 644 "$pub"
        fi
        cat "$pub"
        return 0
      fi
    done

    info "No existing SSH private key detected. Creating ${ssh_dir}/id_ed25519 automatically"
    ssh-keygen -t ed25519 -f "${ssh_dir}/id_ed25519" -N "" -C "liaot@$(hostname)-$(date +%F)" >/dev/null
    cat "${ssh_dir}/id_ed25519.pub"
  }

  add_key_to_authorized_keys() {
    local key_line="$1"
    local auth_file="${HOME}/.ssh/authorized_keys"
    mkdir -p "${HOME}/.ssh"
    chmod 700 "${HOME}/.ssh"
    touch "$auth_file"
    chmod 600 "$auth_file"
    if ! grep -qxF "$key_line" "$auth_file" 2>/dev/null; then
      echo "$key_line" >> "$auth_file"
    fi
  }

  step "Configure firewall (ufw)"
  local ssh_ports_raw
  ssh_ports_raw="$(detect_ssh_ports)"
  if [[ -z "${SSH_PORT:-}" ]]; then
    SSH_PORT="$ssh_ports_raw"
  fi
  SSH_PORT="${SSH_PORT//,/ }"
  SSH_PORT="$(echo "$SSH_PORT" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')"
  [[ -n "$SSH_PORT" ]] || error "Unable to determine SSH port. Please provide --ssh-port manually."
  local p
  for p in $SSH_PORT; do
    validate_port "$p" || error "Invalid SSH port: ${p}"
  done
  info "Auto-detected SSH port(s): ${SSH_PORT}"

  local has_port_22=0
  for p in $SSH_PORT; do
    if [[ "$p" == "22" ]]; then
      has_port_22=1
      break
    fi
  done
  if [[ "$has_port_22" -eq 1 ]] && prompt_yes_no "Detected SSH port 22. Do you want to change the login port?"; then
    local new_ssh_port=""
    while true; do
      new_ssh_port="$(prompt_input "Enter the new SSH port: " || true)"
      [[ -n "$new_ssh_port" ]] || { warn "No input detected. Please try again."; continue; }
      new_ssh_port="${new_ssh_port// /}"
      validate_port "$new_ssh_port" || { warn "Port is invalid. Please try again."; continue; }
      [[ "$new_ssh_port" != "22" ]] || { warn "New port cannot be 22. Please choose another one."; continue; }
      break
    done
    apply_sshd_port "$new_ssh_port"
    SSH_PORT="$new_ssh_port"
    info "SSH login port switched to: ${SSH_PORT}"
  fi

  if prompt_yes_no "Do you want to auto-configure SSH key login (while keeping password login enabled)?"; then
    local detected_pub_key=""
    detected_pub_key="$(detect_or_create_local_public_key)"
    [[ -n "$detected_pub_key" ]] || error "Unable to obtain a usable public key"
    add_key_to_authorized_keys "$detected_pub_key"
    apply_sshd_dropin_and_reload
    success "SSH key login configured. Password login remains enabled."
  fi

  if ! prompt_yes_no "Confirm applying UFW with detected SSH port(s) and allowing only 80/443/5222/5269?"; then
    warn "Firewall changes canceled (did not enter yes)."
    return 0
  fi

  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  for p in $SSH_PORT; do
    ufw allow "${p}/tcp"
  done
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 5222/tcp   # XMPP TCP
  ufw allow 5269/tcp
  ufw allow 3478/tcp comment 'coturn STUN/TURN'
  ufw allow 3478/udp comment 'coturn STUN/TURN'
  ufw allow 5349/tcp comment 'coturn TLS'
  ufw allow 49152:65535/udp comment 'coturn relay'   # XMPP server-to-server
  if prompt_yes_no "Disable ICMP ping (stricter security, but harder network diagnostics)?"; then
    ufw deny in from any to any proto icmp || warn "ICMP rule not applied by ufw, skipping"
  fi
  ufw --force enable
  success "Firewall configuration completed"
}

setup_fail2ban() {
  step "Configure fail2ban (anti-bruteforce)"
  cat > /etc/fail2ban/filter.d/liaot-api.conf << 'EOF'
[Definition]
failregex = ^<HOST> - .* "POST /api/auth/(admin/login|register) HTTP.*" (4[0-9][0-9]) .*
ignoreregex =
EOF

  cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port    = ssh
logpath = %(sshd_log)s

[nginx-http-auth]
enabled = true

[liaot-api]
enabled = true
port = 443
filter = liaot-api
logpath = /var/log/nginx/access.log
maxretry = 5
bantime = 3600
EOF
  systemctl enable fail2ban
  systemctl restart fail2ban
  success "fail2ban configuration completed"
}

setup_backup() {
  step "Configure automated backups"
  mkdir -p /root/backups
  chmod 700 /root/backups
  if [[ -n "${BACKUP_REMOTE}" ]] && ! command -v rclone >/dev/null 2>&1; then
    info "BACKUP_REMOTE is set, installing rclone for offsite sync"
    apt install -y -qq rclone
  fi

  cat > /usr/local/bin/liaot-backup.sh << BACKUP
#!/bin/bash
set -euo pipefail
BACKUP_DIR="/root/backups"
DATE=\$(date +%Y%m%d_%H%M%S)
BACKUP_REMOTE="${BACKUP_REMOTE}"
BACKUP_ENCRYPTION_KEY_FILE="\${BACKUP_ENCRYPTION_KEY_FILE:-/root/.liaot-backup.key}"
DB_NAME="${APP_USER}"
ALERT_EMAIL="${ALERT_EMAIL}"
mkdir -p "\$BACKUP_DIR"
chmod 700 "\$BACKUP_DIR"

# Generate encryption key on first run if missing
if [ ! -f "\$BACKUP_ENCRYPTION_KEY_FILE" ]; then
  openssl rand -base64 48 > "\$BACKUP_ENCRYPTION_KEY_FILE"
  chmod 600 "\$BACKUP_ENCRYPTION_KEY_FILE"
  echo "Generated new backup encryption key at \$BACKUP_ENCRYPTION_KEY_FILE — back this up off-site!"
fi

# Detect whether the installed openssl supports AES-256-GCM with -pbkdf2.
# Older openssl 1.0.x doesn't support GCM via the enc CLI. We prefer GCM
# (AEAD = ciphertext is integrity-protected; tampered backups fail to
# decrypt rather than producing corrupted SQL on restore). Fall back to
# CBC + an external SHA-256 sidecar for older systems.
USE_GCM=0
if openssl enc -aes-256-gcm -pbkdf2 -iter 1 -in /dev/null -pass pass:test -out /dev/null 2>/dev/null; then
  USE_GCM=1
fi

# PBKDF2 iteration count: OWASP 2023 recommends >=600,000 for SHA-256.
# Bumped from 100,000 (the figure quoted in older guides) to follow current
# guidance. Restore-side accepts the higher iteration count when present.
PBKDF2_ITER=600000

alert() {
  local msg="\$1"
  echo "[BACKUP ERROR] \$msg" >&2
  if [ -n "\$ALERT_EMAIL" ] && command -v mail >/dev/null 2>&1; then
    echo "\$msg" | mail -s "Lyao Talk backup failure on \$(hostname)" "\$ALERT_EMAIL" || true
  fi
}

# Disk space pre-check (need at least 1GB free)
AVAILABLE_KB=\$(df -k "\$BACKUP_DIR" | awk 'NR==2 {print \$4}')
if [ "\$AVAILABLE_KB" -lt 1048576 ]; then
  alert "Insufficient disk space (\${AVAILABLE_KB}KB free) for backup"
  exit 1
fi

if [ "\$USE_GCM" = "1" ]; then
  CIPHER="aes-256-gcm"
else
  CIPHER="aes-256-cbc"
fi

# ---- PostgreSQL dump ----
DB_FILE="\${BACKUP_DIR}/db_\${DATE}.sql.gz.enc"
if ! sudo -u postgres pg_dump "\$DB_NAME" | gzip | \
     openssl enc -\${CIPHER} -pbkdf2 -iter \$PBKDF2_ITER -salt \
                 -pass file:"\$BACKUP_ENCRYPTION_KEY_FILE" -out "\$DB_FILE"; then
  alert "PostgreSQL dump failed for \$DB_NAME"
  exit 1
fi

# Verify the encrypted file decrypts cleanly. With GCM this also catches
# tampering (auth-tag mismatch). With CBC it only catches gzip corruption.
if ! openssl enc -d -\${CIPHER} -pbkdf2 -iter \$PBKDF2_ITER \
                 -pass file:"\$BACKUP_ENCRYPTION_KEY_FILE" \
                 -in "\$DB_FILE" 2>/dev/null | gzip -t; then
  alert "Backup verification failed: \$DB_FILE"
  rm -f "\$DB_FILE"
  exit 1
fi

# Always write a SHA-256 sidecar. Two reasons:
#   1. Backwards-compat: old backups used CBC (no AEAD), so a sidecar is the
#      ONLY way to detect tampering for those.
#   2. Defense-in-depth even on GCM: an attacker who replaces both the .enc
#      file AND the .sha256 with a different valid encrypted dump
#      (made with a stolen key) won't match the original — admin sees
#      the discrepancy in the off-site mirror.
sha256sum "\$DB_FILE" > "\$DB_FILE.sha256"
chmod 600 "\$DB_FILE" "\$DB_FILE.sha256"

# Record the cipher used in a metadata file alongside, so restore knows
# which decrypt invocation to attempt without trial-and-error.
cat > "\$DB_FILE.meta" << META
cipher=\$CIPHER
pbkdf2_iter=\$PBKDF2_ITER
created=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
dump_size=\$(stat -c %s "\$DB_FILE")
META
chmod 600 "\$DB_FILE.meta"

# ---- MinIO dump ----
MINIO_FILE="\${BACKUP_DIR}/minio_\${DATE}.tar.gz.enc"
if ! tar czf - --warning=no-file-changed -C / data/minio 2>/dev/null | \
     openssl enc -\${CIPHER} -pbkdf2 -iter \$PBKDF2_ITER -salt \
                 -pass file:"\$BACKUP_ENCRYPTION_KEY_FILE" -out "\$MINIO_FILE"; then
  alert "MinIO backup failed"
  # Don't exit — DB backup already succeeded
else
  sha256sum "\$MINIO_FILE" > "\$MINIO_FILE.sha256"
  chmod 600 "\$MINIO_FILE" "\$MINIO_FILE.sha256"
  cat > "\$MINIO_FILE.meta" << META
cipher=\$CIPHER
pbkdf2_iter=\$PBKDF2_ITER
created=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
dump_size=\$(stat -c %s "\$MINIO_FILE")
META
  chmod 600 "\$MINIO_FILE.meta"
fi

# Retain backups for 7 days (also clean up the sidecars)
find "\$BACKUP_DIR" -name "*.enc" -mtime +7 -delete
find "\$BACKUP_DIR" -name "*.sha256" -mtime +7 -delete
find "\$BACKUP_DIR" -name "*.meta" -mtime +7 -delete

# Remote sync — alert on failure (but don't block local backup)
if [ -n "\$BACKUP_REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  if ! rclone copy "\$BACKUP_DIR/" "\$BACKUP_REMOTE" \
                   --max-age 7d --transfers 2 --checkers 4 \
                   --retries 3 --low-level-retries 5 --timeout 5m; then
    alert "Remote sync to \$BACKUP_REMOTE failed"
  fi
fi

echo "backup completed: \${DATE} (cipher=\$CIPHER iter=\$PBKDF2_ITER)"
BACKUP
  chmod +x /usr/local/bin/liaot-backup.sh

  # Run backup daily at 03:00
  echo "0 3 * * * root /usr/local/bin/liaot-backup.sh >> /var/log/liaot-backup.log 2>&1" \
    > /etc/cron.d/liaot-backup

  success "Backup configured (daily at 03:00)"
}

setup_logrotate_and_journald() {
  step "Configure log rotation and journald limits"
  cp "${SRC_DIR}/configs/logrotate/liaot" /etc/logrotate.d/liaot

  mkdir -p /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/liaot.conf << 'EOF'
[Journal]
SystemMaxUse=500M
EOF
  systemctl restart systemd-journald || true
  success "Log rotation configuration completed"
}

setup_monitoring_alert() {
  step "Configure lightweight service monitoring and self-heal script"
  cat > /usr/local/bin/liaot-alert.sh << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -f /opt/liaot-src/.env ]]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue
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
  done < /opt/liaot-src/.env
fi
services=(postgresql redis-server prosody liaot-api nginx)
ALERT_EMAIL="${ALERT_EMAIL:-}"
for svc in "${services[@]}"; do
  if ! systemctl is-active --quiet "$svc"; then
    msg="$(date '+%F %T') WARN service down: $svc"
    echo "$msg" >> /var/log/liaot-alert.log
    systemctl restart "$svc" || true
    if [[ -n "$ALERT_EMAIL" ]] && command -v mail >/dev/null 2>&1; then
      echo "$msg" | mail -s "Lyao Talk service alert" "$ALERT_EMAIL" || true
    fi
  fi
done

for mount in / /data; do
  if ! df -P "$mount" >/dev/null 2>&1; then
    continue
  fi
  use_pct="$(df -P "$mount" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
  if [[ -n "$use_pct" ]] && (( use_pct >= 90 )); then
    msg="$(date '+%F %T') WARN disk usage high: $mount ${use_pct}%"
    echo "$msg" >> /var/log/liaot-alert.log
    if [[ -n "$ALERT_EMAIL" ]] && command -v mail >/dev/null 2>&1; then
      echo "$msg" | mail -s "Lyao Talk disk alert" "$ALERT_EMAIL" || true
    fi
  fi
done
EOF
  chmod +x /usr/local/bin/liaot-alert.sh
  echo "*/5 * * * * root /usr/local/bin/liaot-alert.sh" > /etc/cron.d/liaot-alert
  success "Monitoring alert script configured (every 5 minutes)"
}

setup_quick_check() {
  cat > /usr/local/bin/liaot-check << 'CHECK'
#!/usr/bin/env bash
set -euo pipefail

echo "=== Lyao Talk 30s Check ==="
for svc in postgresql redis-server prosody minio liaot-api nginx; do
  state=$(systemctl is-active "$svc" 2>/dev/null || true)
  printf "%-16s %s\n" "$svc" "${state:-unknown}"
done

echo ""
echo "--- HTTP ---"
curl -k -I --max-time 8 "https://$1" 2>/dev/null | head -n 1 || echo "https://$1 FAIL"
curl -k -I --max-time 8 "https://$1/api/docs" 2>/dev/null | head -n 1 || echo "https://$1/api/docs FAIL"
CHECK
  chmod +x /usr/local/bin/liaot-check
}

write_secrets_file() {
  local secrets_file="/root/liaot-secrets.txt"
  cat > "${secrets_file}" <<EOF
Lyao Talk Secrets
Generated: $(date '+%F %T')
Domain: ${DOMAIN}

DATABASE_PASSWORD=${DB_PASS}
REDIS_PASSWORD=${REDIS_PASS}
MINIO_ROOT_USER=${MINIO_ROOT_USER}
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
SECRET_KEY=${SECRET_KEY}
XMPP_ADMIN_JID=${XMPP_ADMIN_JID:-${XMPP_ADMIN_USER}@${XMPP_DOMAIN}}
XMPP_ADMIN_PASS=${XMPP_ADMIN_PASS}
ADMIN_USER=${ADMIN_USER}
ADMIN_PASS=${ADMIN_PASS}
EOF
  chmod 600 "${secrets_file}"
}

print_summary() {
  echo ""
  echo -e "${GREEN}============================================================${NC}"
  echo -e "${GREEN}                  Lyao Talk Install Completed                ${NC}"
  echo -e "${GREEN}============================================================${NC}"
  echo ""
  echo -e "  ${CYAN}Web URL:${NC}        https://${DOMAIN}"
  echo -e "  ${CYAN}API Docs:${NC}       https://${DOMAIN}/api/docs"
  echo -e "  ${CYAN}XMPP Domain:${NC}    ${XMPP_DOMAIN}"
  echo -e "  ${CYAN}WebSocket:${NC}      wss://${DOMAIN}/xmpp-websocket"
  echo ""
  echo -e "  ${YELLOW}Default XMPP admin account:${NC}"
  echo -e "  JID: ${XMPP_ADMIN_JID:-${XMPP_ADMIN_USER}@${XMPP_DOMAIN}}"
  if [[ "${XMPP_ADMIN_CREATED}" = "1" ]]; then
    echo -e "  Password: ${XMPP_ADMIN_PASS}"
  else
    echo -e "  Password: (account already existed, existing password kept)"
  fi
  echo ""
  echo -e "  ${YELLOW}Useful commands:${NC}"
  echo -e "  systemctl status liaot-api   # Check API status"
  echo -e "  journalctl -u liaot-api -f   # Follow API logs"
  echo -e "  systemctl status prosody        # Check XMPP status"
  echo -e "  systemctl status nginx          # Check Nginx status"
  echo -e "  liaot-backup.sh              # Run backup now"
  echo -e "  liaot-check ${DOMAIN}        # Run 30-second checks"
  echo ""
  echo -e "  Secrets file: /root/liaot-secrets.txt (chmod 600)"
  echo ""
  echo -e "  ${RED}Store these generated passwords safely:${NC}"
  echo -e "  Database: ${DB_PASS}"
  echo -e "  Redis: ${REDIS_PASS}"
  echo -e "  MinIO: ${MINIO_ROOT_PASSWORD}"
  if [[ "${ADMIN_PASS_PRINT_AT_END:-0}" = "1" ]]; then
    echo ""
    echo -e "  ${RED}=== Web admin password (shown ONCE) ===${NC}"
    echo -e "  ${YELLOW}URL:${NC} https://${DOMAIN}/admin"
    echo -e "  ${YELLOW}User:${NC} ${ADMIN_USER}"
    echo -e "  ${YELLOW}Pass:${NC} ${ADMIN_PASS}"
    echo -e "  ${RED}This password is NOT stored in .env (only the argon2 hash is).${NC}"
    echo -e "  ${RED}Copy it now — there is no way to retrieve it later.${NC}"
    echo -e "  ${RED}Lost it? Re-run the installer to set a new one.${NC}"
  fi
  echo ""
}

main() {
  SRC_DIR="$(pwd -P)"
  [[ -d "${SRC_DIR}/apps/api" ]] || error "Missing source directory: ${SRC_DIR}/apps/api"
  [[ -d "${SRC_DIR}/apps/web" ]] || error "Missing source directory: ${SRC_DIR}/apps/web"

  echo -e "${CYAN}"
  echo -e "${CYAN}Lyao Talk Installer${NC}"
  echo ""




  echo -e "${NC}"

  echo ""

  if [[ "${CONFIGURE_ONLY}" = "1" ]]; then
    bash scripts/env_wizard.sh
    success "Configuration completed. Review .env, then run: sudo bash install.sh --run-local"
    exit 0
  fi

  load_config
  setup_quick_check
  check_system
  configure_package_repos
  upgrade_system_packages
  install_deps
  ensure_service_users
  install_postgres
  install_redis
  # Pre-generate shared secrets so prosody, coturn and api all get the same values.
  PUSH_SHARED_SECRET="${PUSH_SHARED_SECRET:-$(openssl rand -hex 24)}"
  TURN_SECRET="${TURN_SECRET:-$(openssl rand -hex 32)}"
  LDAP_URL="${LDAP_URL:-${LDAP_SERVER:-}}"
  PROMETHEUS_ALLOW_CIDR="${PROMETHEUS_ALLOW_CIDR:-}"
  export PUSH_SHARED_SECRET TURN_SECRET

  install_prosody
  install_minio
  install_nodejs
  deploy_api
  deploy_frontend
  install_nginx
  setup_ssl
  configure_prosody_tls
  install_coturn
  setup_firewall
  setup_fail2ban
  setup_backup
  setup_logrotate_and_journald
  setup_monitoring_alert
  write_secrets_file
  print_summary
}

parse_bootstrap_args "$@"
bootstrap_if_needed
main
