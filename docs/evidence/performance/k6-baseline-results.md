# k6 Performance Baseline Results

Status: PASS_STAGING_BASELINE_WITH_RATE_LIMIT_NOTE

Run date: 2026-05-10
Target: `https://example.com`

Note: this target has production Nginx rate limits enabled
(`api_general` = 300 requests/minute per source IP, burst 50). Public API
readiness tests above that envelope fail with 429 responses from Nginx, not
backend latency.

## Baseline table

| Test | VUs | Duration | p50 | p95 | Error rate | CPU peak | RAM peak | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| health.js | 25 | 1m15s | 4.02ms | 5.91ms | 0.00% | not captured | not captured | PASS |
| api-readiness.js | 4 | 1m15s | 3.82ms | 5.48ms | 0.00% | not captured | not captured | PASS |
| api-readiness.js | 10 | 1m15s | 3.60ms | 5.23ms | 19.07% | not captured | not captured | EXPECTED_FAIL_RATE_LIMIT |

## Resource snapshot

Captured on 2026-05-10 after the production-like run:

```text
Host: Linux cjwmiss 6.1.0-42-cloud-amd64 x86_64
Load average: 0.00, 0.09, 0.17
Memory: 3.8Gi total, 1.1Gi used, 841Mi free, 2.7Gi available
Swap: 2.0Gi total, 4.8Mi used
Disk /: 40G total, 6.0G used, 32G available, 16% used
Services: liaot-api, nginx, prosody, minio, postgresql, redis-server all active
```

## Commands

```bash
BASE_URL=https://example.com VUS=25 RAMP_UP=15s HOLD=45s RAMP_DOWN=15s k6 run examples/loadtest/health.js
BASE_URL=https://example.com VUS=4 RAMP_UP=15s HOLD=45s RAMP_DOWN=15s k6 run examples/loadtest/api-readiness.js

# Demonstrates production gateway limit, not backend saturation:
BASE_URL=https://example.com VUS=10 RAMP_UP=15s HOLD=45s RAMP_DOWN=15s k6 run examples/loadtest/api-readiness.js
```

## Database evidence

Run after test:

```bash
sudo -u postgres psql liaot -f scripts/sql/hot_queries.sql
sudo -u postgres psql liaot -f scripts/sql/index_usage.sql
sudo -u postgres psql liaot -f scripts/sql/table_bloat_candidates.sql
```

Attach outputs here.

### 2026-05-10 database evidence

`hot_queries.sql` could not run because `pg_stat_statements` is not enabled on
the target:

```text
ERROR: relation "pg_stat_statements" does not exist
```

`index_usage.sql` completed. The staging dataset is small, so several indexes
show `idx_scan = 0`; this is expected until realistic chat traffic exists.
Notable rows included:

```text
plugins_name_key                 idx_scan=0 size=16 kB
ix_messages_body_trgm            idx_scan=0 size=16 kB
ix_attachments_owner_account_id  idx_scan=0 size=16 kB
```

`table_bloat_candidates.sql` completed. Current table sizes are tiny:

```text
attachments: 25 live rows, 4 dead rows
accounts: 2 live rows, 3 dead rows
plugins: 6 live rows, 0 dead rows
messages/conversations/contacts: 0 live rows
```

Follow-up: enable `pg_stat_statements` on a disposable staging run before
claiming hot-query coverage.

## 2026-05-13 staging baseline

Target: `https://staging.example.com`

| Test | VUs | Duration | p95 | Error rate | Result |
|---|---:|---:|---:|---:|---:|
| health.js | 10 | 70s | 5.25ms | 0.00% | PASS |
| api-readiness.js | 10 | 70s | n/a | 17.25% | EXPECTED_FAIL_RATE_LIMIT |
| health.js | 2 | 50s | 4.92ms | 0.00% | PASS |
| api-readiness.js | 2 | 50s | 5.18ms | 0.00% | PASS |

Finding:

At 10 VUs, `api-readiness.js` exceeded the staging Nginx API rate limit
(`api_general rate=300r/m`, `burst=50 nodelay`) and returned 429 for
`/api/config/runtime`. A single curl to the same endpoint returned 200.
The lower 2 VU run stayed inside the gateway envelope and passed with low
latency.

Database performance collection:

```text
pg_stat_statements enabled via shared_preload_libraries
PostgreSQL restarted
liaot-api restarted
CREATE EXTENSION IF NOT EXISTS pg_stat_statements
```

Transient run directories created during the staging run:

```text
/tmp/liaot-plan/docs/evidence/performance/runs/20260511T210911Z
/tmp/liaot-plan/docs/evidence/performance/db-20260511T213631Z/pg-stat-extension.txt
/tmp/liaot-plan/docs/evidence/performance/db-20260511T213631Z/hot-queries.txt
/tmp/liaot-plan/docs/evidence/performance/db-20260511T213631Z/index-usage.txt
/tmp/liaot-plan/docs/evidence/performance/db-20260511T213631Z/table-stats.txt
```

Those `/tmp` directories were not persistent after the staging host cleanup;
the durable evidence retained here is the run summary, p95/error-rate outcome,
rate-limit diagnosis, and `pg_stat_statements` enablement result.
