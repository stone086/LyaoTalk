# LiaoT Performance Baseline

Release: `2.0.0-performance-baseline`

This file is the canonical place to record release performance numbers. The
2.0.0 package adds the tools and gates; staging operators should fill the
measured values after running against a clean staging deployment.

## Release gate commands

```bash
bash scripts/performance_validate.sh
bash scripts/stage0_validate.sh --local
bash scripts/trusted_build_validate.sh --local
bash scripts/observability_validate.sh
```

## k6 baseline commands

```bash
BASE_URL=https://staging.example.com k6 run examples/loadtest/health.js
BASE_URL=https://staging.example.com k6 run examples/loadtest/api-readiness.js
```

## Baseline table

| Scenario | Target | Measured p50 | Measured p95 | Error rate | CPU peak | Memory peak | Notes |
|---|---:|---:|---:|---:|---:|---:|---|
| `/api/health` 25 VUs | p95 < 750ms, errors < 1% | TBD | TBD | TBD | TBD | TBD | Run `health.js` |
| public API readiness 100 VUs | p95 < 1500ms, errors < 2% | TBD | TBD | TBD | TBD | TBD | Run `api-readiness.js` |
| 1000-message conversation scroll | p95 < 2000ms | TBD | TBD | TBD | TBD | TBD | Browser/staging manual test |
| 100MB upload to MinIO | completes without 5xx | TBD | TBD | TBD | TBD | TBD | Measure nginx -> API -> MinIO |
| Prosody 100 c2s connections | no reconnect storm | TBD | TBD | TBD | TBD | TBD | Use XMPP load fixture |

## Database review commands

Enable query statistics on staging:

```bash
sudo -u postgres psql liaot -f scripts/sql/enable_pg_stat_statements.sql
```

Review hot queries:

```bash
sudo -u postgres psql liaot -f scripts/sql/hot_queries.sql
```

Review unused indexes:

```bash
sudo -u postgres psql liaot -f scripts/sql/index_usage.sql
```

Review table vacuum/analyze health:

```bash
sudo -u postgres psql liaot -f scripts/sql/table_bloat_candidates.sql
```

## N+1 query detection

The API now counts SQL statements per request with SQLAlchemy events. When a
request exceeds `PERF_QUERY_WARN_THRESHOLD` queries, the API writes a structured
log event:

```text
n_plus_one_suspected
```

Relevant environment settings:

```env
PERF_QUERY_COUNT_ENABLED=true
PERF_QUERY_WARN_THRESHOLD=10
PERF_SLOW_SQL_MS=250
```

For production, leave this on during the first release window. If the overhead
is unacceptable, set `PERF_QUERY_COUNT_ENABLED=false` after collecting a
baseline.
