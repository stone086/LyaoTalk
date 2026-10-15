# Audit Evidence Checklist

Version: 2.3.0

Use this checklist before sending the project to an external auditor.

## Build/release evidence

- [ ] Release zip hash recorded.
- [ ] `VERSION`, root `package.json`, web `package.json`, and `.env.example` versions match.
- [ ] `npm ci` passed.
- [ ] `npm run build` passed.
- [ ] `npm test -- --run` passed.
- [ ] `npm audit --omit=dev --audit-level=high` passed or exceptions documented.
- [ ] `pip install --require-hashes -r apps/api/requirements.txt` passed on staging Python version.
- [ ] `pip-audit` output saved.
- [ ] Bandit output saved.
- [ ] SBOM for Python and Node generated.

## Runtime evidence

- [ ] Fresh staging install completed.
- [ ] `nginx -t` passed.
- [ ] `prosodyctl check config` passed.
- [ ] `alembic upgrade head` passed.
- [ ] Admin login works.
- [ ] Two standard users can exchange messages.
- [ ] Upload/download works.
- [ ] `/api/health` returns 200.
- [ ] `/api/metrics` accessible only from approved IPs.
- [ ] JSON logs include request id.

## Security evidence

- [ ] CSP console session has no unexpected violations.
- [ ] Attachment cross-user access negative test passed.
- [ ] Refresh token rotation/logout test passed.
- [ ] OIDC email verification behavior tested if SSO enabled.
- [ ] OMEMO trust-state persistence tested.
- [ ] Key-change warning tested.
- [ ] Backup archive contents reviewed for secrets policy.
- [ ] Backup restore drill completed.

## Audit package

- [ ] `docs/security/THREAT_MODEL.md` included.
- [ ] `docs/audit/external-audit-brief.md` included.
- [ ] `docs/audit/pentest-scope.md` included.
- [ ] `docs/audit/bug-bounty-draft.md` included.
- [ ] `docs/audit/known-issues-register.md` updated.
- [ ] Staging credentials delivered out-of-band.
