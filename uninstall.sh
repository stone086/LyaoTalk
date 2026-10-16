#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-lyaotalk}"
INSTALL_DIR="${INSTALL_DIR:-/opt/lyaotalk}"
SRC_DIR="${SRC_DIR:-/opt/lyaotalk-src}"

echo "This will remove LyaoTalk services and local data."
read -r -p "Type YES to continue: " confirm
[[ "$confirm" == "YES" ]] || { echo "Canceled."; exit 1; }

systemctl stop lyaotalk-api minio prosody nginx redis-server postgresql 2>/dev/null || true
systemctl disable lyaotalk-api minio 2>/dev/null || true

rm -f /etc/systemd/system/lyaotalk-api.service
rm -f /etc/systemd/system/minio.service
systemctl daemon-reload

if id -u postgres >/dev/null 2>&1; then
  sudo -u postgres psql -c "DROP DATABASE IF EXISTS \"${APP_USER}\";" || true
  sudo -u postgres psql -c "DROP ROLE IF EXISTS \"${APP_USER}\";" || true
fi

rm -rf "${INSTALL_DIR}" "${SRC_DIR}" /data/minio
rm -f /etc/nginx/sites-enabled/lyaotalk
rm -f /etc/nginx/sites-available/lyaotalk
rm -f /etc/nginx/conf.d/lyaotalk-rate-limit.conf
rm -f /etc/cron.d/lyaotalk-backup /etc/cron.d/lyaotalk-alert
rm -f /usr/local/bin/lyaotalk-backup.sh /usr/local/bin/lyaotalk-check /usr/local/bin/lyaotalk-alert.sh
rm -f /etc/logrotate.d/lyaotalk
rm -f /etc/systemd/journald.conf.d/lyaotalk.conf

nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
systemctl restart systemd-journald 2>/dev/null || true

echo "LyaoTalk uninstall completed."
