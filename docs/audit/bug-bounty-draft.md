# Bug Bounty Draft Policy

Version: 2.3.0
Status: draft, not public until reviewed

## Program summary

LiaoT is a private chat/community platform using a web frontend, FastAPI backend, Prosody/XMPP, PostgreSQL, Redis, MinIO, and optional OMEMO-style encrypted messaging flows.

This draft is intended for a private, invitation-only bounty first. Do not publish publicly until staging is isolated and legal terms are reviewed.

## Safe harbor

Researchers acting in good faith, staying within this policy, and reporting promptly will not be pursued for accidental, non-destructive testing activity. This safe harbor does not authorize access to third-party services, real user data, or production systems unless explicitly listed as in scope.

## In scope

- Staging web app and API.
- Test accounts provided by the program.
- Authorization bypass, XSS, CSRF, SSRF-like behavior, IDOR, upload bugs, token/session bugs.
- OMEMO trust-state and key-change implementation issues that can be demonstrated with test accounts.
- Supply-chain/release issues in the public repository if the repository is included in the program.

## Out of scope

- Volumetric DDoS.
- Spam, phishing, or social engineering.
- Physical attacks.
- Third-party provider vulnerabilities.
- Reports requiring compromised browser extensions or malware.
- Missing security headers without exploitable impact.
- Self-XSS that cannot affect another user.
- Rate-limit findings without meaningful security impact.

## Severity guidance

| Severity | Examples |
|---|---|
| Critical | unauthenticated remote code execution, full database dump, admin takeover, JWT signing key leak |
| High | account takeover, stored XSS against admin, cross-user attachment disclosure, auth bypass |
| Medium | reflected XSS with user interaction, limited IDOR, token leakage under special conditions |
| Low | minor information disclosure, low-impact misconfiguration |

## Rewards placeholder

Final rewards depend on budget. Suggested private pilot range:

| Severity | Suggested range |
|---|---:|
| Critical | $1,000 - $3,000 |
| High | $300 - $1,000 |
| Medium | $100 - $300 |
| Low | Thanks / discretionary |

## Report requirements

A valid report should include:

- affected URL/component;
- exact reproduction steps;
- account used;
- screenshots or logs;
- impact statement;
- suggested fix if known.

## Prohibited actions

- Accessing or modifying real user data.
- Persistence, backdoors, malware, crypto-mining.
- Public disclosure before remediation window.
- Automated high-volume scanning without prior written approval.

## Triage process

1. Acknowledge within 3 business days.
2. Validate severity within 10 business days.
3. Fix critical/high issues before next production release.
4. Retest with researcher when possible.
5. Publish sanitized advisory only after mitigation.
