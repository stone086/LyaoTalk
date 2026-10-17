# Known Issues Register

Version: 2.3.6

Use this file for risks intentionally deferred or accepted before external audit.

| ID | Title | Severity | Component | Status | Owner | Target fix | Acceptance expiry | Notes |
|---|---|---|---|---|---|---|---|---|
| KI-001 | OMEMO third-party interop evidence incomplete | Medium | Web/XMPP | Open | Project owner | Real-client staging tests | TBD | Requires Conversations/Gajim/Dino staging tests. |
| KI-002 | Forward secrecy runtime proof not independently verified | High | OMEMO | Open | Project owner | External crypto review | TBD | Do not market as independently audited E2EE. |
| KI-003 | Performance baseline lacks process resource peaks | Medium | Performance | Open | Project owner | Staging measurement | TBD | k6 latency and error rates were collected, but CPU/RAM peaks and representative database traffic were not. |
| KI-004 | Cross-browser and reconnect matrix incomplete | Medium | Web | Open | Project owner | Real-device validation | TBD | Firefox, Safari, iOS PWA, Android and chaos cases remain pending in the compatibility evidence. |
| KI-005 | External security audit incomplete | High | Full stack | Open | Project owner | External review | TBD | No independent audit sign-off; avoid audited-security claims. |

## Entry template

| ID | Title | Severity | Component | Status | Owner | Target fix | Acceptance expiry | Notes |
|---|---|---|---|---|---|---|---|---|
| KI-XXX |  |  |  | Open |  |  |  |  |
