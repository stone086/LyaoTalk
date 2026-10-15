import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: __ENV.RAMP_UP || '2m', target: Number(__ENV.VUS || 100) },
    { duration: __ENV.HOLD || '5m', target: Number(__ENV.VUS || 100) },
    { duration: __ENV.RAMP_DOWN || '2m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://staging.liaot.example.com';

export default function () {
  const health = http.get(`${BASE_URL}/api/health`, { tags: { endpoint: 'health' } });
  check(health, { 'health 200': (r) => r.status === 200 });

  // Public endpoints only. Authenticated chat flows should be tested with a
  // staging-only token/user fixture and never with production credentials.
  const config = http.get(`${BASE_URL}/api/config/runtime`, { tags: { endpoint: 'runtime_config' } });
  check(config, { 'runtime config 200': (r) => r.status === 200 });

  sleep(Math.random() * 2);
}
