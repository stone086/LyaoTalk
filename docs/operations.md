# Operations Runbook

## Service status
```bash
cd /opt/lyaotalk-src
bash manage.sh status
```

## Common restart actions
```bash
bash manage.sh restart-api
bash manage.sh restart-nginx
bash manage.sh restart
```

## API and health checks
```bash
bash manage.sh check
bash manage.sh api-health
curl -fsS https://YOUR_DOMAIN/api/health
```

## TLS certificate checks
```bash
bash manage.sh cert-info
bash manage.sh ssl-renew
```

## Backups and verification
```bash
bash manage.sh backup
bash manage.sh backup-verify
bash manage.sh disk-usage
```

## DB migration rollback
```bash
bash manage.sh db-history
bash manage.sh db-rollback
```

## Traffic and port diagnostics
```bash
bash manage.sh top-requests
bash manage.sh ports
```

## Environment validation
```bash
bash manage.sh env-check
```

## Watchdog/manual self-heal
```bash
bash manage.sh watchdog
```

## Systemd templates
- `configs/systemd/lyaotalk-api.service.template`
- `configs/systemd/minio.service.template`

Use templates as reference for manual recovery or migration to a new host.

