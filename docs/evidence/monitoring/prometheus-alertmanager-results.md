# Prometheus / Alertmanager Evidence

Status: PASS_STAGING_REAL_TARGET

## Prometheus target health

| Target | Result | Evidence |
|---|---:|---|
| LiaoT API `/metrics` | UP | Prometheus target `liaot-api` scraped `http://127.0.0.1:8000/metrics` |
| Alert rules loaded | PASS | `LiaoTStagingAlertSmoke` entered firing state |
| Alertmanager reachable | PASS | Alertmanager API showed the smoke alert as active |

## 2026-05-13 staging validation

Target: `https://staging.example.com`

```text
scripts/observability_validate.sh
[OK] metrics render smoke test
[OK] observability static validation passed

systemctl is-active prometheus prometheus-alertmanager
active
active

Prometheus target:
job=liaot-api instance=127.0.0.1:8000 health=up scrapeUrl=http://127.0.0.1:8000/metrics

Prometheus alert:
LiaoTStagingAlertSmoke state=firing value=1

Alertmanager alert:
LiaoTStagingAlertSmoke status=active receiver=staging-null
```

Notes:

- Public `/metrics` remains restricted by Nginx; the real Prometheus target is local-only.
- Alertmanager required `--cluster.listen-address=` on this single-node VPS because no private advertise address is present.

## 2026-05-10 validation

```text
scripts/observability_validate.sh
[OK] metrics render smoke test
[OK] observability static validation passed

curl https://example.com/api/metrics
HTTP 403
```

The 403 confirms `/api/metrics` is not publicly exposed. To complete this
evidence, run Prometheus/Alertmanager from an allowed monitoring host, set
`PROMETHEUS_ALLOW_CIDR`, and capture the Prometheus target as UP.

## Commands

```bash
docker compose -f examples/observability/docker-compose.observability.yml up -d
curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS http://127.0.0.1:9093/-/ready
curl -fsS https://staging.example.com/api/metrics | head -40
docker compose -f examples/observability/docker-compose.observability.yml exec prometheus \
  promtool check rules /etc/prometheus/rules/liaot-alerts.yml
```

## Sample alert-fire test

Temporarily trigger repeated admin login failures against staging and confirm `LiaoTAdminLoginFailures` enters pending/firing state.

Result: PASS on staging smoke alert
