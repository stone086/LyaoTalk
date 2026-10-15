# LiaoT upgrade acceptance status — 2026-10-13

Production: `liaot.2-yc.com` on `rabisuB` (`143.246.43.42`). This is a shared host; Matrix also runs on it. Tests below use temporary LiaoT accounts and remove them afterward.

## Verified

| Area | Evidence |
| --- | --- |
| Python | Python 3.12.15 was built from the official source archive after checking its SHA-256. The API runs from `/opt/liaot-venv312`; `pip install --require-hashes` and `pip check` passed. |
| Python dependency security | `pip-audit` on the Python 3.12 lock found no known vulnerabilities. Bandit with `-ll -ii` passed. |
| Python tests and CodeQL | The complete Python 3.12 suite passed 73/73 in an isolated configuration, including a run with Redis intentionally unavailable. After the download-auth change, the isolated server candidate also passed 73/73. GitHub Actions run `38335361578` passed API unit tests, web tests and build, shell validation, and both Python and JavaScript/TypeScript CodeQL jobs. |
| Frontend | `npm ci`, 25 Vitest tests, TypeScript/Vite build, and `npm audit --omit=dev --audit-level=high` passed. The production audit still reports five moderate findings. |
| API | Public HTTPS health check returned 200 after the Python 3.12 switch. Live registration, user token, text upload, download through `upload.liaot.2-yc.com`, and admin login returned 200. |
| Sessions | Live temporary account: bad password 401, correct password 200, refresh 200, reused refresh 401, logout revoked access and refresh, disabling the account rejected old access and refresh with 403. |
| Private files | Two temporary accounts: owner download 200 with exact bytes, other account 404, anonymous 401. A reusable JWT in `?t=` was rejected with 401 on both the API and upload subdomain; Authorization-header download on the upload subdomain returned 200. The deployed web app retrieves private media as authenticated blobs and revokes local blob URLs on cleanup. |
| XMPP | Two temporary accounts authenticated with Slixmpp, fetched rosters, exchanged a direct message, joined and configured a MUC room, exchanged a group message, negotiated XEP-0198 Stream Management, and retrieved a direct message via MAM. |
| External XMPP | On 2026-10-13, the user-provided `test1@chat.52nbc.com` account and a temporary LiaoT account both authenticated. Before the firewall fix, LiaoT to external delivery passed but the reverse direction returned `remote-server-not-found`. With the user's explicit approval, UFW on rabisuB was changed to allow only source `38.47.119.75` to `5269/tcp`. Both directions then delivered messages; Prosody logged an encrypted inbound s2s connection with SASL EXTERNAL from `chat.52nbc.com`. All temporary LiaoT accounts were removed. |
| External OMEMO discovery | From `test1@chat.52nbc.com`, both the legacy OMEMO device list and OMEMO 2 device list for the existing LiaoT account were readable, each with one device. Its corresponding public bundles were also readable. This establishes device discovery across federation, but does not yet prove encrypted send/decrypt interoperability. |
| Data recovery | PostgreSQL, Prosody, Redis, and MinIO backup archives were created under `/var/backups/liaot/20261012T153655Z` and verified with SHA-256. PostgreSQL and Redis were restored in isolated test instances; Prosody and MinIO data were extracted into an isolated restore directory. |
| Domains | HTTPS and DNS verified for the main, conference, and upload subdomains. Browser WebSocket upgrade returned 101 with the expected Origin. |

## Open acceptance items

- Five moderate npm advisories remain through Converse headless and React Router. Available fixes require major-version migrations. Review these migrations separately; do not use `npm audit fix --force` on production without compatibility testing.
- Live browser compatibility in Chrome, Firefox, and Safari; iPhone background recovery; browser refresh/reopen behavior; and OMEMO multi-device and third-party interoperability have not been demonstrated. The local browser automation interface timed out while binding the open LiaoT page.
- Message receipts, full reconnect/resume behavior, sustained concurrent-user/database load, image/voice uploads, and actual rollback to a previous application version still need dedicated tests.
- Password changes made directly in Prosody do not currently invalidate already issued REST JWTs. An application-managed password-change flow or a session-version fence is needed.
- The `5269/tcp` ingress is limited to the current IPv4 address of `chat.52nbc.com`; other public XMPP servers still cannot initiate federation. TURN remains blocked by the host firewall. If the external server's source IP changes, the rule must be reviewed and updated. Browser chat over HTTPS 443 works.
- Encrypted OMEMO ciphertext exchange and successful decryption with the user's external client remain unverified, despite device list and bundle discovery passing.
- MinIO binary was built from its community source because official release binaries were unavailable at the time. Pin a reviewed source revision and document repeatable builds before treating this as a fully reproducible release.

## Rollback material

The pre-Python-3.12 API unit and code copies are saved under `/var/backups/liaot/pre-python312`. The data archive above includes SHA-256 sidecars. Do not restore the data archive over the live database without a maintenance window; the isolated restore test used a separate database and Redis port.
