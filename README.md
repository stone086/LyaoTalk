# Lyao Talk

**More Than Just Chat.**

Lyao Talk is an XMPP-based web messaging app. This repository starts with an independent Git history. It imports a source-code snapshot without any prior LiaoT commits, pull requests, issues or tags.

## Development

- Frontend: `apps/web` (React, TypeScript, Vite)
- Backend: `apps/api` (FastAPI)
- Messaging server: Prosody

Run `npm --prefix apps/web ci`, `npm --prefix apps/web run build`, and `npm --prefix apps/web test` to validate the frontend.

**Deployment status:** source import only. Production and CI configuration must be reviewed before deployment. The original live LiaoT service remains unchanged.
