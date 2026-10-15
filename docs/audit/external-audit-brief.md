# External Audit Brief

Version: 2.3.0
Audience: security audit vendors, pentest providers, internal reviewers

## Objective

Assess whether LiaoT is safe enough for a private production deployment with real user accounts, messages, attachments, admin operations, and XMPP interoperability.

## Repository baseline

- Release candidate: LiaoT 2.3.0 external-audit-ready
- Prior phases completed: trusted build, observability, performance baseline, compatibility chaos, ops runbook.
- Required pre-audit setup: staging deployment with representative domain, TLS, Prosody, PostgreSQL, Redis, MinIO, nginx, and test accounts.

## Audit workstreams

| Workstream | Expected coverage |
|---|---|
| Web/API pentest | auth, session, CSRF, XSS, IDOR, SSRF-like fetches, uploads, admin APIs |
| XMPP/security review | stanza validation, room state, malicious contact data, OMEMO payload paths |
| Crypto implementation review | OMEMO identity/session/prekey/trust state, key-change warnings, storage |
| Infra/config review | nginx, Prosody, MinIO, systemd hardening, env handling, backups |
| Supply-chain review | npm lock, hash-pinned Python, CI gates, SBOM, release packaging |
| Operational readiness | incident response, backup restore, secret rotation, monitoring alerts |

## Deliverables requested from vendor

1. Executive summary with go/no-go production recommendation.
2. Technical findings with reproduction steps.
3. Severity rating using CVSS or vendor equivalent.
4. Exploitability and affected component/version.
5. Concrete remediation guidance.
6. Retest after fixes.
7. Separate crypto-risk appendix if OMEMO is included.

## Non-negotiable constraints

- No destructive testing on production.
- Use staging unless explicitly approved.
- No access to real user data.
- No persistence, malware, crypto-mining, or social engineering unless separately authorized in writing.
- Report critical findings immediately through the emergency contact channel.

## Vendor access package

Provide the auditor:

- Source zip or repository read access.
- Staging base URL.
- Admin test account.
- Two standard user accounts.
- One OIDC/LDAP test path if enabled.
- MinIO test bucket/object fixtures.
- Prometheus/metrics read-only access if available.
- `docs/security/THREAT_MODEL.md`.
- `docs/audit/pentest-scope.md`.
- `docs/audit/audit-evidence-checklist.md`.

## Success criteria

Audit is considered complete when:

- All critical/high findings have fixes or documented temporary mitigations.
- Retest confirms fixed critical/high issues.
- All accepted risks have owner and expiry.
- Release notes mention security-relevant fixes without exposing exploit details.
