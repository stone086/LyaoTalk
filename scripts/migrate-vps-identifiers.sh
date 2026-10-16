#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ -f /etc/lyaotalk/api.env && -d /opt/lyaotalk-releases/49402c9 ]] || {
  echo "Expected LyaoTalk release host is not present" >&2; exit 1;
}
[[ ! -e /opt/lyaotalk-current ]] || { echo "Current symlink already exists; inspect migration state" >&2; exit 1; }
getent passwd liaot >/dev/null
getent group liaot >/dev/null
for unit in lyaotalk-api lyaotalk-minio lyaotalk-redis prosody matrix-synapse mas nginx; do
  systemctl is-active --quiet "$unit"
done

/usr/local/sbin/lyaotalk-backup
install -d -m 700 /root/lyaotalk-identifier-migration
cp -a /etc/systemd/system/lyaotalk-api.service \
      /etc/systemd/system/lyaotalk-minio.service \
      /etc/systemd/system/lyaotalk-redis.service \
      /etc/prosody/prosody.cfg.lua \
      /etc/nginx/sites-available/lyaotalk \
      /root/lyaotalk-identifier-migration/

ln -s /opt/lyaotalk-releases/49402c9 /opt/lyaotalk-current
systemctl stop lyaotalk-api lyaotalk-minio lyaotalk-redis
usermod -l lyaotalk -d /var/lib/lyaotalk liaot
groupmod -n lyaotalk liaot

python3 - <<'PY'
from pathlib import Path

for service in ('lyaotalk-api', 'lyaotalk-minio', 'lyaotalk-redis'):
    path = Path('/etc/systemd/system') / f'{service}.service'
    text = path.read_text().replace('User=liaot\n', 'User=lyaotalk\n').replace('Group=liaot\n', 'Group=lyaotalk\n')
    if service == 'lyaotalk-api':
        text = text.replace('/opt/lyaotalk-releases/49402c9/apps/api', '/opt/lyaotalk-current/apps/api')
    path.write_text(text)

nginx = Path('/etc/nginx/sites-available/lyaotalk')
text = nginx.read_text().replace('/opt/lyaotalk-releases/49402c9/apps/web/dist', '/opt/lyaotalk-current/apps/web/dist')
text = text.replace('/etc/nginx/sites-available/liaot', '/etc/nginx/sites-available/lyaotalk')
text = text.replace('liaot-rate-limit.conf', 'lyaotalk-rate-limit.conf')
nginx.write_text(text)

prosody = Path('/etc/prosody/prosody.cfg.lua')
text = prosody.read_text().replace('LiaoT', 'LyaoTalk').replace('mod_liaot_push.lua', 'mod_lyaotalk_push.lua')
text = text.replace('liaot_push', 'lyaotalk_push')
needle = '  restrict_room_creation = "local"\n'
if needle not in text:
    raise SystemExit('MUC creation restriction not found')
text = text.replace(needle, needle + '  muc_room_default_persistent = true\n', 1)
prosody.write_text(text)
PY

install -m 644 /opt/lyaotalk-src/configs/prosody/mod_lyaotalk_push.lua \
  /usr/lib/prosody-modules/mod_lyaotalk_push.lua
cat > /etc/systemd/system/lyaotalk-prosody.socket <<'EOF'
[Unit]
Description=LyaoTalk Prosody registration socket
[Socket]
ListenStream=/run/lyaotalk-prosody.sock
SocketUser=prosody
SocketGroup=lyaotalk
SocketMode=0660
RemoveOnStop=yes
[Install]
WantedBy=sockets.target
EOF
cat > /etc/systemd/system/lyaotalk-prosody.service <<'EOF'
[Unit]
Description=LyaoTalk Prosody registration helper
Requires=lyaotalk-prosody.socket
After=prosody.service
[Service]
Type=simple
User=prosody
Group=prosody
Environment=LYAOTALK_XMPP_DOMAIN=lyaot.2-yc.com
ExecStart=/usr/bin/python3 /opt/lyaotalk-src/configs/prosody/lyaotalk_registration_helper.py
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/prosody
PrivateTmp=true
EOF

systemctl daemon-reload
prosodyctl check config
nginx -t
systemctl enable --now lyaotalk-prosody.socket
systemctl start lyaotalk-redis lyaotalk-minio lyaotalk-api
systemctl restart prosody
systemctl reload nginx
curl -fsS --max-time 15 https://lyaot.2-yc.com/api/health >/dev/null
systemctl is-active --quiet matrix-synapse mas nginx lyaotalk-api lyaotalk-minio lyaotalk-redis prosody
echo "LyaoTalk service user, helper socket, MUC persistence, and active configs migrated"
