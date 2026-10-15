# Troubleshooting

## SSL certificate issuance fails
1. Verify DNS points to your VPS.
```bash
dig +short YOUR_DOMAIN
nslookup YOUR_DOMAIN
```
2. Verify ports `80` and `443` are open.
```bash
ss -tlnp | grep -E ':80|:443'
ufw status
```
3. Re-run cert flow.
```bash
bash manage.sh ssl-renew
```

## API service fails to start
```bash
systemctl status liaot-api
journalctl -u liaot-api -n 100 --no-pager
systemctl status postgresql redis-server
```

## Migration issues
```bash
cd /opt/liaot/api
.venv/bin/alembic current
.venv/bin/alembic upgrade head
```

## XMPP connection issues
```bash
systemctl status prosody
tail -n 50 /var/log/prosody/prosody.log
ss -tlnp | grep 5280
curl -I https://YOUR_DOMAIN/xmpp-websocket
```

## Frontend blank page
```bash
tail -n 50 /var/log/nginx/error.log
ls -la /opt/liaot/web/dist
bash manage.sh update-front
```

## File upload/download issues
```bash
systemctl status minio
/usr/local/bin/mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
/usr/local/bin/mc ls local/
/usr/local/bin/mc anonymous get local/liaot-files
```
Expected: bucket is private (`none` policy), not public download.

## Memory pressure
```bash
bash manage.sh mem-usage
free -h
```

## Useful logs
```bash
journalctl -u liaot-api -f
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
tail -f /var/log/prosody/prosody.log
journalctl -u postgresql -f
journalctl -u redis-server -f
journalctl -u minio -f
```

## Admin credential reset
1. Check runtime env:
```bash
grep -E '^ADMIN_USER=|^ADMIN_PASS=' /opt/liaot/api/.env
```
2. Restart API:
```bash
systemctl restart liaot-api
```

## Certificate expiry
```bash
openssl x509 -enddate -noout -in /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem
bash manage.sh ssl-renew
```
