<div align="center">
  <img src="apps/web/public/lyaotalk-wordmark.png" alt="Lyao Talk — More Than Just Chat" width="720" />
</div>

# Lyao Talk

**More Than Just Chat.**

Lyao Talk is an open-source XMPP-based web messaging app, built with React, TypeScript, FastAPI and Prosody.

<div align="center">
  <img src="apps/web/public/lyaotalk-original-icon.png" alt="Lyao Talk app icon" width="180" />
</div>

## Development

- Frontend: `apps/web` (React, TypeScript, Vite)
- Backend: `apps/api` (FastAPI)
- Messaging server: Prosody
- Current application version: `2.3.5`

Run `npm --prefix apps/web ci`, `npm --prefix apps/web run build`, and `npm --prefix apps/web test` to validate the frontend.

## Deployment

See [VPS deployment and rollback instructions](docs/DEPLOYMENT.md). CI validation does not imply that the production VPS has been updated. The original LiaoT server is unchanged until a separately approved cutover.
