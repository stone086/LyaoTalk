# LiaoT k6 load tests

Run these against staging first. Do not run them against production without a maintenance window.

```bash
BASE_URL=https://staging.example.com k6 run examples/loadtest/health.js
BASE_URL=https://staging.example.com k6 run examples/loadtest/api-readiness.js
```

The scripts intentionally use public endpoints by default. Add authenticated chat scenarios only with staging-only fixture users.
