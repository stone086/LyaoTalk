#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-liaot}"
INSTALL_DIR="${INSTALL_DIR:-/opt/liaot}"
SRC_DIR="${SRC_DIR:-/opt/liaot-src}"

echo "This will remove LiaoT services and local data."
read -r -p "Type YES to continue: " confirm
[[ "$confirm" == "YES" ]] || { echo "Canceled."; exit 1; }

systemctl stop liaot-api minio prosody nginx redis-server postgresql 2>/dev/null || true
systemctl disable liaot-api minio 2>/dev/null || true

rm -f /etc/systemd/system/liaot-api.service
rm -f /etc/systemd/system/minio.service
systemctl daemon-reload

if id -u postgres >/dev/null 2>&1; then
  sudo -u postgres psql -c "DROP DATABASE IF EXISTS \"${APP_USER}\";" || true
  sudo -u postgres psql -c "DROP ROLE IF EXISTS \"${APP_USER}\";" || true
fi

rm -rf "${INSTALL_DIR}" "${SRC_DIR}" /data/minio
rm -f /etc/nginx/sites-enabled/liaot
rm -f /etc/nginx/sites-available/liaot
rm -f /etc/nginx/conf.d/liaot-rate-limit.conf
rm -f /etc/cron.d/liaot-backup /etc/cron.d/liaot-alert
rm -f /usr/local/bin/liaot-backup.sh /usr/local/bin/liaot-check /usr/local/bin/liaot-alert.sh
rm -f /etc/logrotate.d/liaot
rm -f /etc/systemd/journald.conf.d/liaot.conf

nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
systemctl restart systemd-journald 2>/dev/null || true

echo "LiaoT uninstall completed."
