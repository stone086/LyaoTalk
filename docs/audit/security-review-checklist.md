# Security Review Checklist

Version: 2.3.0

## Pre-review

- [ ] Review threat model.
- [ ] Confirm staging target is isolated from production.
- [ ] Create disposable test accounts.
- [ ] Snapshot staging before destructive tests.
- [ ] Confirm emergency contact channel.

## Code review focus

- [ ] Auth and refresh-token flows.
- [ ] Admin route authorization.
- [ ] Attachment object authorization.
- [ ] XMPP stanza handling.
- [ ] OMEMO identity/session/trust persistence.
- [ ] URL/link-preview sanitization.
- [ ] CSP and nginx proxy headers.
- [ ] Installer scripts and `.env` parsing.
- [ ] Backup and restore scripts.

## Dynamic testing focus

- [ ] Cross-user reads/writes.
- [ ] Stored XSS in all user-controlled text fields.
- [ ] Upload MIME and file extension confusion.
- [ ] Token replay and logout revocation.
- [ ] Rate-limit and lockout behavior.
- [ ] Metrics endpoint access control.
- [ ] Service worker cache data exposure.

## Closeout

- [ ] Findings triaged.
- [ ] Critical/high fixed or blocked from release.
- [ ] Retest evidence attached.
- [ ] Known issues register updated.
