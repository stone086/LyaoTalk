# Browser Compatibility and Chaos Results

Status: PARTIAL_STATIC_AND_API_SMOKE

## Browser matrix

| Browser | OS/device | Login | Messaging | Upload | OMEMO | Push/PWA | Reconnect | Result | Evidence |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Chrome | Windows/macOS/Android | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | screenshot/log |
| Edge | Windows | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | screenshot/log |
| Firefox | Windows/Linux | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | screenshot/log |
| Safari | macOS 16+ | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | screenshot/log |
| iOS Safari PWA | iPhone | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | screenshot/log |
| Samsung Internet | Android | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | screenshot/log |

## Automated smoke collected on 2026-05-10

```text
https://example.com/ returned HTTP 200 and served index.html.
Security headers present: HSTS, X-Frame-Options, X-Content-Type-Options,
Referrer-Policy, Permissions-Policy, COOP, CORP, CSP, Reporting-Endpoints.
CSP keeps img-src at 'self' blob:; QR rendering was changed to canvas, so
data: image sources are not required.
scripts/compatibility_chaos_validate.sh passed static validation.
```

Authenticated attachment smoke with `cjw001` and `cjw002`:

```text
cjw001 uploaded a PNG named "真机复测-中文图片.png".
Same-account download returned 200 image/png.
Same-account download after simulated 10-minute age returned 200 image/png.
cjw002 cross-account download returned 404.
Content-Disposition included RFC 5987 filename*=UTF-8.
```

Edge headless screenshot was attempted from the Windows desktop environment but
did not produce an artifact, so it is not counted as a browser PASS.

## Chaos cases

| Case | Result | Evidence |
|---|---:|---|
| Network drops while sending a message | PENDING | screenshot + console log |
| Token expires while uploading | PENDING | network trace |
| Prosody restarts during active chat | PENDING | reconnect log |
| MinIO unavailable during upload | PENDING | upload UI error screenshot |
| Browser closes mid-send | PENDING | pending/sent reconciliation screenshot |

Note: this file still requires real browser/device evidence before the matrix
can be marked PASS. Safari, iOS PWA, Android/Samsung Internet, push/PWA, call
startup, and offline service-worker behavior are not proven by the static smoke.
