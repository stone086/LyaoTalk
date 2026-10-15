# VPS Smoke Test

Run this after `manage.sh update` or a fresh install.

## System Checks

```bash
cd /opt/liaot-src
git rev-parse --short HEAD
nginx -t
systemctl is-active nginx prosody postgresql redis-server liaot-api
curl -fsS https://127.0.0.1/api/health -k
```

## Browser Checks

| Case | Expected result | Status |
| --- | --- | --- |
| Open site | Login page loads without console errors | TODO |
| Register user | New XMPP user can be created | TODO |
| Login user | User reaches chat UI and shows connected state | TODO |
| Add contact | Contact request appears on the receiver side | TODO |
| Accept contact | Both contacts appear without repeated pending request loops | TODO |
| Send short message | Receiver sees message without refresh | TODO |
| Send long message | Receiver sees full long text | TODO |
| Refresh page | Recent messages remain visible | TODO |
| Upload attachment | File uploads and appears in chat | TODO |
| File history | Right panel Files tab lists uploaded attachment | TODO |
| OMEMO untrusted device | Send is blocked until fingerprint verification | TODO |
| OMEMO verified device | Encrypted message sends and decrypts | TODO |

## Useful Logs

```bash
journalctl -u liaot-api -n 200 --no-pager
journalctl -u prosody -n 200 --no-pager
tail -n 200 /var/log/nginx/error.log
tail -n 200 /var/log/prosody/prosody.err
```

## Pass Criteria

- All services are active.
- `nginx -t` succeeds.
- `/api/health` returns success.
- Login, registration, messaging, upload, file history, and OMEMO checks pass.
- No new 4xx/5xx errors appear during normal user flows.
