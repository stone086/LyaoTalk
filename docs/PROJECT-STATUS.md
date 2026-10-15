# LiaoT Project Status (v1.5.1)

## Production-ready modules

- React + TypeScript + Vite frontend (16k+ lines)
- FastAPI async backend (3.4k+ lines)
- XMPP via strophe.js (XEP-0280, XEP-0198, XEP-0357, XEP-0313 MAM)
- OMEMO E2EE (services/omemo + services/e2ee, using libsignal-protocol-typescript)
- Jingle 1:1 audio/video calls with WebRTC + coturn
- Group calls via mesh topology (experimental, wired into ChatPage)
- SSO: OIDC + LDAP with secure code exchange and rate limiting
- Admin dashboard, plugin system, webhook inbound
- Full installer for Debian 12 VPS (install.sh / manage.sh)

## OMEMO encryption (single implementation)

Production code in `services/omemo/` + `services/e2ee.ts`:
- libsignal-protocol-typescript for key management and Signal sessions
- Dual namespace support: `urn:xmpp:omemo:2` + `eu.siacs.conversations.axolotl` (legacy)
- Decrypt chain: libsignal standard → legacy custom protocol fallback
- IndexedDB-backed key store (migrated from localStorage)
- Trust management UI via OmemoTrustView

Previously existing prototype code (omemo2/, omemo-engine/) has been deleted.
It was never referenced by production code and contained only placeholders.

## Known gaps

- OIDC id_token signature verification (currently relies on userinfo endpoint)
- Group call SFU for 6+ participants (mesh only for now)
- Meta-contacts: store + sync + UI exist, but no merge suggestion algorithm
- RAG: backend ready, minimal frontend entry in GlobalSearch
