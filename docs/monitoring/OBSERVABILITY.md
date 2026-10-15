# LiaoT 1.9.0 Observability

This release adds first-class operational visibility without adding new Python runtime dependencies.

## What is included

- JSON structured logs by default through `app.core.logging`.
- A request middleware that attaches `X-Request-ID` and records HTTP request counters and latency histograms.
- A Prometheus-compatible scrape endpoint at `/api/metrics` through nginx, proxied to the FastAPI route `/metrics`.
- Event counters for high-value security/ops signals such as `admin_login_failed`, `admin_login_ok`, `csp_violation`, and accepted web vital reports.
- Prometheus alert rules in `configs/prometheus/liaot-alerts.yml`.

## Environment settings

```env
LOG_LEVEL=INFO
LOG_FORMAT=json
METRICS_ENABLED=true
```

Set `LOG_FORMAT=text` only for local debugging. Production should keep JSON logs so systemd journal, Loki, ELK, or Vector can parse fields such as `request_id`, `path`, `status_code`, and `elapsed_ms`.

## Metrics endpoint

Nginx exposes:

```text
/api/metrics
```

The nginx config restricts it to localhost and private RFC1918 networks. If Prometheus runs on a different network, add its IP/CIDR to `configs/nginx/liaot.conf` before deployment.

Local check on the server:

```bash
curl -fsS http://127.0.0.1:8000/metrics | head
curl -fsS https://YOUR_DOMAIN/api/metrics | head
```

Expected metrics include:

```text
liaot_build_info
liaot_process_uptime_seconds
liaot_http_requests_total
liaot_http_request_duration_seconds_bucket
liaot_events_total
```

## Prometheus scrape example

```yaml
scrape_configs:
  - job_name: liaot-api
    metrics_path: /api/metrics
    scheme: https
    static_configs:
      - targets: ["chat.example.com"]
```

## Alert rules

Import:

```text
configs/prometheus/liaot-alerts.yml
```

Initial alerts:

- API 5xx rate > 1% for 5 minutes.
- Admin login failures > 5 in 5 minutes.
- Any CSP violation.
- API p95 latency > 2 seconds for 10 minutes.

## Notes

The in-process metrics registry is intentionally lightweight. If you run multiple API workers or multiple hosts, scrape every instance and aggregate in Prometheus.
