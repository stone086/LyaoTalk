import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: __ENV.RAMP_UP || '1m', target: Number(__ENV.VUS || 25) },
    { duration: __ENV.HOLD || '2m', target: Number(__ENV.VUS || 25) },
    { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<750'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://staging.liaot.example.com';

export default function () {
  const res = http.get(`${BASE_URL}/api/health`, {
    tags: { endpoint: 'health' },
  });
  check(res, {
    'health status is 200': (r) => r.status === 200,
    'health says ok': (r) => String(r.body).includes('"status":"ok"'),
  });
  sleep(1);
}
