# LiaoT Threat Model

Version: 2.3.0
Status: external-audit-ready draft

## 1. Scope

This threat model covers the LiaoT web client, FastAPI backend, Prosody/XMPP layer, PostgreSQL, Redis, MinIO object storage, nginx, deployment scripts, CI/release artifacts, and operational processes documented under `docs/runbook/`.

Out of scope for this document unless explicitly added to an audit statement of work:

- Physical server compromise.
- Malicious operating system kernel or hypervisor.
- Compromised user endpoint before browser launch.
- Third-party identity provider compromise beyond OIDC/LDAP integration handling.
- Cryptographic proof of OMEMO correctness. That requires a dedicated cryptography audit.

## 2. Primary assets

| Asset | Why it matters |
|---|---|
| User account credentials and refresh tokens | Account takeover risk |
| JWT signing secret | Full session forgery if leaked |
| PostgreSQL data | Messages, contacts, audit events, identities |
| MinIO objects and attachment metadata | File disclosure risk |
| OMEMO identity/session/prekey material | End-to-end encryption trust boundary |
| Prosody account and room state | Chat availability and identity routing |
| Admin credentials | Full administrative control |
| Backups and snapshots | Bulk data exposure and recovery capability |
| CI/release artifacts | Supply-chain integrity |

## 3. Trust boundaries

| Boundary | Trusted side | Untrusted side | Main risks |
|---|---|---|---|
| Browser ↔ nginx | Server-controlled TLS endpoint | User browser / network | XSS, CSRF, token theft, CSP gaps |
| nginx ↔ API | Local reverse proxy | Public internet | Header spoofing, origin bypass |
| API ↔ PostgreSQL | Backend service identity | SQL inputs | Injection, migration mistakes, overbroad privileges |
| API ↔ MinIO | Backend storage credentials | Object keys from clients | IDOR, signed URL misuse, orphan files |
| Web client ↔ XMPP/Prosody | Authenticated user session | XMPP stanzas from others | stanza spoofing, trust downgrade, state desync |
| CI ↔ dependency registries | Locked dependency metadata | Package registries | dependency confusion, transitive compromise |
| Operator ↔ production shell | Root/admin operator | Scripts and env files | secret leakage, destructive rollout |

## 4. Actor model

| Actor | Capability |
|---|---|
| Anonymous internet attacker | Can send HTTP requests, attempt registration/login, scan endpoints |
| Authenticated user | Can send messages, upload files, join allowed rooms, trigger previews |
| Malicious contact | Can send XMPP stanzas, media URLs, OMEMO payloads, names/avatars |
| Compromised admin browser | Can act as admin until tokens are revoked |
| Malicious dependency maintainer | Can publish compromised package updates if locks are bypassed |
| Insider/operator mistake | Can misconfigure DNS, env, backups, or rollback |

## 5. STRIDE summary

| Category | Main threats | Current mitigations | Audit focus |
|---|---|---|---|
| Spoofing | forged tokens, spoofed proxy IP, OIDC identity confusion | JWT secret, refresh token store, X-Real-IP preference, OIDC `sub`/email checks | verify token validation, proxy trust, OIDC edge cases |
| Tampering | message state changes, object key manipulation, migrations | DB constraints, attachment auth-check, migrations 0007/0008 | IDOR tests, race tests, migration rollback |
| Repudiation | missing admin/action records | audit logs with PII masking | verify all privileged actions emit audit events |
| Information disclosure | XSS, CSP bypass, attachment leakage, backup leakage | URL safety filters, CSP, MinIO checks, runbook controls | XSS, CSP, signed object access, backup encryption |
| Denial of service | auth brute force, slow requests, upload abuse, DB hot queries | nginx limits, metrics/alerts, query/perf tooling | rate-limit bypass, upload limits, resource exhaustion |
| Elevation of privilege | admin API access, plugin/webhook abuse, SSO mapping bugs | role checks, audit, SSO validation | RBAC matrix and authorization bypass testing |

## 6. Highest-risk areas for auditors

1. OMEMO and trust state handling, especially key-change behavior and local persistence.
2. Attachment authorization and object key access paths.
3. Refresh token rotation, logout revocation, and JWT `jti` handling.
4. Admin APIs, plugin settings, webhook handling, and audit coverage.
5. XMPP stanza parsing and malicious remote contact inputs.
6. nginx/CSP/URL-safety interactions.
7. Installer and upgrade scripts that run with high privileges.
8. Dependency lock and CI release trust.

## 7. Required evidence before audit kickoff

- Latest staging URL and test accounts.
- Architecture diagram and data-flow map.
- Current `.env` template with secrets removed.
- SBOM artifacts for Python and Node.
- Recent `npm audit`, `pip-audit`, Bandit, CodeQL outputs.
- OMEMO runtime validation notes.
- Backup restore drill evidence.
- Known-issues register with accepted risk decisions.

## 8. Risk acceptance format

Use `docs/audit/known-issues-register.md` for accepted risks. Each item must include owner, severity, exploitability, affected versions, mitigation, target fix version, and acceptance expiration date.
