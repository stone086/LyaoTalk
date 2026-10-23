#!/usr/bin/env bash
# One-time rabisuB migration for Prosody 13 XEP-0363 file uploads.
set -euo pipefail

domain=lyaot.2-yc.com
prosody_config=/etc/prosody/prosody.cfg.lua
nginx_config=/etc/nginx/sites-enabled/lyaotalk-subdomains
stamp="$(date -u +%Y%m%d%H%M%S)"
prosody_backup="${prosody_config}.pre-http-upload-${stamp}"
nginx_backup="/etc/lyaotalk/lyaotalk-subdomains.pre-http-upload-${stamp}"

[[ "$(id -u)" -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
[[ -f /usr/lib/prosody/modules/mod_http_file_share.lua ]] || { echo 'mod_http_file_share missing' >&2; exit 1; }
[[ -f "$prosody_config" && -f "$nginx_config" ]] || { echo 'Expected VPS config missing' >&2; exit 1; }
if grep -q 'Component "upload.lyaot.2-yc.com" "http_upload"' "$prosody_config"; then
  echo "Legacy http_upload data needs explicit migration before enabling http_file_share" >&2; exit 1
fi
if grep -q 'Component "upload.lyaot.2-yc.com" "http_file_share"' "$prosody_config"; then
  echo 'HTTP upload already configured'; exit 0
fi
grep -q 'server_name upload.lyaot.2-yc.com;' "$nginx_config" || { echo 'Upload vhost missing' >&2; exit 1; }

cp -p "$prosody_config" "$prosody_backup"
cp -p "$nginx_config" "$nginx_backup"
rollback() {
  cp -p "$prosody_backup" "$prosody_config"
  cp -p "$nginx_backup" "$nginx_config"
  systemctl restart prosody || true
  nginx -t && systemctl reload nginx || true
  echo "Restored $prosody_backup and $nginx_backup" >&2
}
trap rollback ERR

cat >> "$prosody_config" <<'LUA'

-- XEP-0363 HTTP upload for native XMPP clients (Conversations, Monal).
Component "upload.lyaot.2-yc.com" "http_file_share"
  modules_disabled = { "s2s" }
  http_host = "upload.lyaot.2-yc.com"
  http_external_url = "https://upload.lyaot.2-yc.com/"
  http_file_share_size_limit = 100 * 1024 * 1024
  http_file_share_daily_quota = 500 * 1024 * 1024
  http_file_share_expires_after = "30 days"
LUA

python3 - "$prosody_config" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
needle = 'VirtualHost "lyaot.2-yc.com"'
if text.count(needle) != 1:
    raise SystemExit('Expected one primary VirtualHost')
text = text.replace(needle, 'http_max_content_size = 101 * 1024 * 1024\n\n' + needle)
path.write_text(text)
PY

python3 - "$nginx_config" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
needle = '    location / { return 404; }\n}'
if text.count(needle) != 1:
    raise SystemExit('Expected exactly one upload-vhost catch-all')
route = '''    location ^~ /file_share/ {
        client_max_body_size 101m;
        proxy_pass http://127.0.0.1:5280;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_request_buffering off;
        add_header X-Content-Type-Options nosniff always;
        add_header Content-Security-Policy "default-src 'none'; sandbox" always;
    }
'''
route = '''    location = /file_share {
        proxy_pass http://127.0.0.1:5280;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
''' + route
path.write_text(text.replace(needle, route + needle))
PY

prosodyctl check config
nginx -t
systemctl restart prosody
systemctl reload nginx
systemctl is-active --quiet prosody nginx
healthy=false
for attempt in {1..10}; do
  if curl -sS -o /dev/null --max-time 5 https://upload.lyaot.2-yc.com/file_share; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]] || { echo 'Public upload URL failed health check' >&2; exit 1; }
trap - ERR
echo "Enabled XEP-0363 HTTP upload for $domain; backups: $prosody_backup $nginx_backup"
