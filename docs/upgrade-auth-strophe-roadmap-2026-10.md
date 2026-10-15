# LiaoT authentication, XMPP and security upgrade roadmap

**Historical record (2026-10-12).** This plan and its version numbers, security findings, CI outcomes, and release status describe the former PR #2 branch at that date. The current release baseline is `main`; verify current dependencies and acceptance evidence there before making decisions. The document is retained to preserve the original roadmap and review history.

## Architecture and inventory

- Frontend: React/Vite, `apps/web`; XMPP transport: `strophe.js: ^1.6.2`; additional `@converse/headless: ^10.1.6` dependency.
- Backend: FastAPI (`apps/api`), Prosody XMPP, Redis revocation denylist.
- XMPP login: `LoginPage` → `xmppAdapter` → Strophe WebSocket/SASL → Prosody.
- REST login: `POST /auth/user-token` validates XMPP credentials and returns account ID plus JWT access/refresh tokens.
- REST token acquisition is optional for successful XMPP login; dependent API functionality must expose an explicit degraded state.
- `accountStore` writes XMPP password to `sessionStorage`, while `api.ts` stores JWT and refresh token there. `signedFilesUrl` appends bearer tokens to `?t=` media URLs.
- `security.py` has a Redis-backed JWT revocation denylist that fails open by default unless `JWT_DENY_ON_REVOCATION_BACKEND_FAILURE=1`.

## P0 — Reproducible baseline (required gate)

1. Preserve existing production version and lockfile. Inspect exact `node_modules/strophe.js` entry in `apps/web/package-lock.json` and dependency tree; assess security advisories and supported Node versions.
2. Run `npm ci`, `npm run build`, `npm test`, `npm run check:buttons`; run the API test suite.
3. Record results, supported browser matrix, Prosody configuration/version, and staging restore test; no production rollout if baseline unverified.

## P1 — Authentication consistency

1. **Implemented:** remove the duplicate `/auth/user-token` password exchange on successful XMPP login while retaining the early request to resolve server-side account_id.
2. Test four states: XMPP+REST success; XMPP success/REST denied; XMPP denied/REST success; initial REST unavailable.
3. Review account migration and session cleanup; prevent stale tokens from surviving failed XMPP authentication for an existing account. Coordinate XMPP disconnect with API logout/revocation without collateral impact on other accounts.
4. Introduce explicit REST-auth availability state in the UI; gate API-only features when bearer token is unavailable.
5. Add per-account token and refresh tests, including concurrent 401 responses, refresh rotation, logout, password reset and account disable.

## P2 — Credential and API transport hardening

1. Remove XMPP password from browser session storage if reliable reconnect flows can instead obtain a short-lived credential or prompt again. Do not silently break reconnect.
2. Replace long-lived JS-readable refresh-token storage with a suitable secure design (consider HttpOnly Secure SameSite cookie scoped to backend, CSRF protections, multi-account implications).
3. Replace `?t=<bearer>` media URLs: evaluate short-lived, scope-limited signed URLs or an authenticated blob fetch. Ensure Nginx, application and CDN logs never capture bearer tokens.
4. Review API/backend TLS verification, privileged `prosodyctl` invocation, password/hash checking fallbacks, admin legacy plaintext mode and rate limits.
5. Review CSP/XSS, JWT audience/issuer/type/account binding, revocation fail-open vs fail-closed, rotation and key handling.

## P3 — Strophe and Converse upgrade (separate breaking-change PR)

1. Determine exact resolved Strophe and Converse dependency versions. Verify currently supported upstream releases and security advisories before selecting the target.
2. Map all direct Strophe calls and plugins: connection callbacks, auth, WebSocket/BOSH, IQ handlers, stanza utilities, stream management, CSI, MAM, reconnection and message carbons.
3. Validate `@converse/headless` coupling before changing major versions; prefer one XMPP runtime and avoid incompatible duplicate instances.
4. Upgrade dependency manifest **and regenerate package-lock.json together** using npm; never hand-edit only the version specifier.
5. Pass unit/build integration tests, real Prosody staging SASL/login/reconnection tests, offline/online transitions and WebSocket failure scenarios. No blanket production upgrade before verification.

## P4 — OMEMO and interoperability

1. Test own-device bundle publication, contact device-list discovery, key rotation and broken-session recovery.
2. Exercise text, edits, replies, reactions, files, groupchat and multi-device carbons in both encrypted and unencrypted modes.
3. Run documented real-client interoperability matrix (including a second standards-compliant XMPP client) before release.
4. Verify key material is not logged and local database/storage policies are explicit.

## P5 — Release operations and rollback

1. Run backend tests, frontend build, browser E2E and security tests.
2. Back up database, Prosody data and configuration; verify restoration on staging.
3. Use a canary rollout with auth success, JWT refresh failures, disconnect/reconnect and message delivery monitoring.
4. Keep `main` and deployed service unchanged until PR review and gates pass; roll back by redeploying the previous commit and lockfile, reversing config only when compatible.

## Acceptance matrix

| Scenario | Expected |
| --- | --- |
| Valid JID/password | One REST token request per initial login, XMPP connected |
| REST 401 / XMPP valid | Chat works, API-only features marked unavailable |
| REST valid / XMPP invalid | Login denied; no reusable stale REST session |
| 30-minute token expiry | Authorized API refresh is safe and per-account |
| Sign out/disable/reset | Local credentials cleared, remote revocation behavior verified |
| Network lost/recovered | Reconnect succeeds without unauthorized credential reuse |
| Browser reload | Explicit documented UX for restoring XMPP connection |
| OMEMO multiple devices | Encryption/decryption/interoperability passes |
| Media file URL | No reusable bearer token leaked into URL or request logs |
| Deploy rollback | Previous known-good version works with retained data |

## CI dependency fix procedure

- `aiohttp==3.13.5` on CPython 3.12 / Linux x86_64 uses PyPI verified wheel SHA-256 `b18f31b80d5a33661e08c89e202edabf1986e9b49c42b4504371daeaa11b47c1`; added it without removing prior hashes or `--require-hashes`. Other wheel mismatches, if any, must be separately verified on PyPI.
- CI identified the next missing Linux CPython 3.12 wheel hash for `asyncpg==0.30.0`. Checked against the PyPI 0.30.0 release artifact page and added SHA-256 `1292b84ee06ac8a2ad8e51c7475aa309245874b61333d97411aab835c4a2f737`. A broader pip-compile regeneration across intended Python/runtime platforms is still necessary; this is an incremental unblock, not an assurance that all wheel hashes are complete.
- Frontend npm audit reports Axios vulnerabilities requiring a reviewed move from the current exact pin to 1.20.0 or later, including regeneration of `package-lock.json`. The Converse/headless breaking upgrade must remain separate until compatibility tests pass. Never suppress npm audit just to make CI green.

## 2026-10-12 additional CI triage

- CI run 38259845124 reveals the next missing pinned wheel SHA-256 for `cffi==2.0.0` on CPython 3.12 Linux x86_64. Checked it against the PyPI release file record; included `3e17ed538242334bf70832644a32a7aae3d83b57567f9fd60a26257e992b79ba` without weakening hash checks.
- Repeated hash mismatches indicate the lockfile generated on Python 3.10 is incomplete for the Linux Python 3.12 CI runner. A comprehensive regenerate-and-review of every locked artifact supported by production/CI is required; do not repeatedly copy unverified `Got` hashes into production.
- npm audit remains failing; the dependency manifest and lockfile must be updated together using a verified npm environment, with an explicit Strophe/Converse compatibility gate.

## Dependency lock refresh workflow (release blocker)

- Added `.github/workflows/dependency-lock-refresh.yml` on the upgrade branch, triggered on PRs and manually once present on default branch.
- For Python 3.12 Linux, CI runs `piptools compile --generate-hashes` from `requirements.in`, then tests `pip install --require-hashes` and uploads `python312-lock-candidate`.
- Review the candidate's complete version and hash changes before replacing the committed `requirements.txt`. This diagnostic job **does not** change protected branches or relax the mandatory release CI.
- For npm, CI uploads a machine-readable `npm-audit-report` while also building and testing. A production audit success is still required before release.
- Existing mandatory CI still fails on a subsequent `charset-normalizer==3.4.7` Python 3.12 Linux wheel hash and on npm production vulnerabilities. Do not label release ready until both are fixed and a full CI run passes.
- XMPP integration, OMEMO interoperability, deployment backup/restore and rollback rehearsal remain mandatory manual release gates.

## Rollout record

- 2026-10-12: P1 changes on feature branch: `LoginPage.tsx` requests `/auth/user-token` once; account/password/token updates occur after XMPP connection succeeds; failed authentication does not replace an existing saved account session.
- 2026-10-12: API 401 refresh associates requests with their resolved account and only treats an admin token as an admin session when that token was actually attached.
- 2026-10-12: P2 partial mitigation: `signedFilesUrl` now refuses to attach a bearer token to a cross-origin `/files/` URL. Regression test added. Same-origin URLs **still use `?t=<bearer>`** pending replacement with scoped media authorization.
- CI run 38258763222: web build/test, shell and CodeQL succeeded, but npm security audit failed (5 high / 7 moderate) and API hashed dependency install failed on `aiohttp==3.13.5` wheel hash mismatch. Treat both as blockers; do not bypass hash validation or run `npm audit fix --force` unreviewed.
- Latest branch commits require fresh CI verification; real-device interoperability has not run. No production approval.
