# LiaoT 2.1.0 Compatibility & Chaos Runbook

This release implements the roadmap stage for browser compatibility and edge-case recovery. The goal is not only to support mainstream browsers, but to prove that failures are visible, recoverable, and documented.

## Browser support targets

| Browser | Required checks |
| --- | --- |
| Chrome / Edge latest | Login, reconnect, text messaging, file upload, OMEMO send/decrypt, Web Push, PWA install |
| Firefox latest | Login, reconnect, text messaging, file upload, OMEMO send/decrypt |
| Safari 16+ | IndexedDB availability, PWA install state, Web Push limitation messaging, WebCrypto, OMEMO send/decrypt |
| iOS Safari | Home Screen PWA requirement for push, storage availability outside private mode |
| Samsung Internet | Login, reconnect, upload, notification behavior if used by target users |

## Safari and iOS known constraints

- IndexedDB may be unavailable or ephemeral in private mode. The UI/runtime diagnostics must treat missing IndexedDB as a blocker for OMEMO trust persistence.
- iOS Web Push requires the app to be installed as a Home Screen PWA.
- Service Worker and push state can be evicted by the platform after inactivity; users may need to reopen the PWA.
- WebCrypto must be available over HTTPS; unsupported embedded webviews are not acceptable for encrypted sessions.

## Runtime diagnostics

`apps/web/src/services/browserCompatibility.ts` provides:

- browser family detection;
- capability collection;
- compatibility findings for IndexedDB, WebCrypto, Service Worker, PushManager, Notification, BroadcastChannel, and online state;
- a stable chaos scenario list used by tests and the manual runbook.

## Chaos test expectations

| Scenario | Expected behavior |
| --- | --- |
| Network drops during send | Pending message is retried or fails visibly; it must not silently disappear. |
| Token expires during upload | Refresh runs once and upload retries, or user is prompted before losing context. |
| Prosody restarts | Connection supervisor reconnects and status is visible. |
| MinIO unavailable | Upload shows a clear storage error and supports retry. |
| Browser closes during send | Reopen does not show a false delivered state. |

## Evidence template

Create `docs/compatibility/compatibility-chaos-results.md` on staging with:

- test date, build version, browser version, OS/device;
- exact steps;
- screenshots or screen recordings;
- request IDs and timestamps;
- related `journalctl`, nginx, Prosody, and API logs;
- pass/fail and follow-up issue links.
