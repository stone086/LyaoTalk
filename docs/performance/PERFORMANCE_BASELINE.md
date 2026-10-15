# Performance Baseline Runbook

This runbook implements roadmap stage 4 for LiaoT 2.0.0: k6 load tests,
N+1 query detection, database index usage review, and performance baseline
recording.

## 1. Prepare staging

Use a staging server with the same Nginx, Prosody, PostgreSQL, Redis, MinIO and
API topology as production. Do not use production accounts or production data.

```bash
sudo systemctl status liaot-api prosody nginx minio
curl -fsS https://staging.example.com/api/health
curl -fsS http://127.0.0.1:8000/metrics | head
```

## 2. Run local package checks

```bash
bash scripts/performance_validate.sh
bash scripts/stage0_validate.sh --local
bash scripts/trusted_build_validate.sh --local
bash scripts/observability_validate.sh
```

## 3. Run k6 smoke/load tests

```bash
BASE_URL=https://staging.example.com k6 run examples/loadtest/health.js
BASE_URL=https://staging.example.com k6 run examples/loadtest/api-readiness.js
```

Record p50, p95, failure rate, CPU peak, memory peak and any 5xx in
`docs/performance-baseline.md`.

## 4. Watch N+1 and slow SQL logs

```bash
journalctl -u liaot-api -f --no-pager | grep -E 'n_plus_one_suspected|slow_sql'
```

For any `n_plus_one_suspected` event, record:

- route
- query count
- total SQL milliseconds
- max SQL milliseconds
- suspected router/service file
- proposed fix: `selectinload`, `joinedload`, subquery, or batch query

## 5. Review PostgreSQL statistics

```bash
sudo -u postgres psql liaot -f scripts/sql/enable_pg_stat_statements.sql
sudo -u postgres psql liaot -f scripts/sql/hot_queries.sql
sudo -u postgres psql liaot -f scripts/sql/index_usage.sql
sudo -u postgres psql liaot -f scripts/sql/table_bloat_candidates.sql
```

If `pg_stat_statements` is not loaded, add it to `shared_preload_libraries`,
restart PostgreSQL during a staging maintenance window, then run the extension
script again.

## 6. Promotion gate

Do not promote the release until these are true:

- k6 smoke test has < 1% failures.
- public API readiness test has < 2% failures.
- no repeated `n_plus_one_suspected` events on core chat routes.
- no hot query dominates total DB time without a remediation note.
- performance numbers are recorded in `docs/performance-baseline.md`.
