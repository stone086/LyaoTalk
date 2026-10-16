# LyaoTalk Monitoring Runbook

Version: 2.2.0 ops-runbook

## Main signals

| Signal | Source | Action |
|---|---|---|
| API 5xx rate | Prometheus `lyaotalk_http_requests_total` | inspect API logs and DB |
| API p95 latency | Prometheus histogram | inspect slow SQL and CPU |
| admin login failures | `lyaotalk_events_total` and audit logs | block brute force |
| CSP violations | event metric and audit logs | distinguish attack vs bad CSP |
| disk usage | node exporter / systemd | clean backups/uploads |
| certificate expiry | blackbox/exporter or certbot timer | renew certificate |

## Quick checks

```bash
curl -fsS http://127.0.0.1:8000/metrics | head
sudo journalctl -u lyaotalk-api -n 100 --no-pager
sudo systemctl status lyaotalk-api prosody nginx minio --no-pager
sudo df -h
```

## Alert: API 5xx rate high

1. Check recent deploys.
2. Check DB connectivity.
3. Check API logs for exception names.
4. Roll back if caused by deploy.

```bash
sudo journalctl -u lyaotalk-api --since "15 min ago" --no-pager
sudo -u postgres psql lyaotalk -c "SELECT now();"
```

## Alert: p95 latency high

1. Check slow SQL logs.
2. Run hot query report.
3. Check CPU and memory.
4. Compare with `docs/performance-baseline.md`.

```bash
sudo journalctl -u lyaotalk-api --since "15 min ago" --no-pager | grep slow_sql || true
sudo -u postgres psql lyaotalk -f scripts/sql/hot_queries.sql
```

## Alert: disk usage high

1. Identify biggest path.
2. Clean old build caches and expired backups.
3. Do not delete MinIO data manually unless restore plan is known.

```bash
sudo du -hxd1 /opt /var | sort -h | tail -30
```

## Alert: certificate expires soon

```bash
sudo certbot certificates
sudo systemctl status certbot.timer --no-pager
sudo certbot renew --dry-run
```
