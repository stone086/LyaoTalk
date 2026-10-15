# LiaoT v1.5.0 Release Notes

Release date: 2026-04-22

LiaoT v1.5.0 upgrades the native self-hosted XMPP web client into a broader IM platform release. It builds on the v1.4 branch and keeps the v1.4 login/bootstrap compatibility fixes.

## Highlights

- PWA push notification support using XEP-0357 style server push plus Web Push/VAPID.
- Link preview cards with server-side preview fetching and SSRF guardrails.
- OIDC and LDAP login endpoints for enterprise SSO flows.
- Server discovery and public health badge endpoints.
- AI utilities for summary, smart reply, translation, assistant responses, and RAG over stored message history.
- Voice messages, call UI, Jingle session helpers, and group-call scaffolding.
- Cross-device sync helpers for starred and pinned state.
- Local full-text search with MiniSearch and IndexedDB.
- OMEMO trust UI and libsignal-based OMEMO service scaffolding.
- Prosody push module template and installer wiring.

## Upgrade Notes

Back up before upgrading:

```bash
sudo /usr/local/bin/liaot-backup.sh
```

Update source and services from an existing native install:

```bash
cd /opt/liaot-src
git pull
bash manage.sh update
```

If applying files manually, rebuild the API and frontend:

```bash
cd /opt/liaot/api
.venv/bin/pip install -r requirements.txt
.venv/bin/alembic upgrade head

cd /opt/liaot/web
npm install
npm run build

sudo systemctl restart prosody liaot-api
sudo systemctl reload nginx
```

New runtime values created or used by this release:

```bash
VAPID_PRIVATE_KEY=...
VAPID_PUBLIC_KEY=...
PUSH_SHARED_SECRET=...
TURN_SECRET=...
OIDC_ENABLED=false
LDAP_ENABLED=false
```

Fresh installs should use `install.sh`; it generates VAPID and push secrets automatically.

## Known Limits

- Group calls currently use mesh topology. Larger rooms should use a future SFU integration.
- Some link previews may be unavailable when a remote site blocks server-side fetching.
- Meta-contact sync is currently local-first; full PEP-backed multi-device sync is planned.
- OMEMO interoperability should be validated with Conversations and Gajim before production use.
- The installer supports apt-based systemd distributions. Debian 12 remains the primary production target; Ubuntu and Zorin are supported best-effort targets.

## Verification Checklist

- `npm run build` succeeds in `apps/web`.
- `python3 -m compileall apps/api/app apps/api/tests` succeeds.
- `bash -n install.sh` succeeds.
- `bash manage.sh check` passes on a deployed VPS.
- Login, registration, contact add/accept, messaging, attachment upload, push subscription, and OMEMO trust flows are manually smoke-tested.
