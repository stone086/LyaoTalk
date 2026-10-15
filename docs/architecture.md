# Architecture

## Runtime topology
- Internet -> Nginx (443)
- Nginx -> FastAPI (`127.0.0.1:8000`) for `/api/*`
- Nginx -> Prosody (`127.0.0.1:5280`) for `/xmpp-websocket`
- Nginx -> MinIO (`127.0.0.1:9000`) for `/files/*`
- FastAPI -> PostgreSQL + Redis

## Services
- `liaot-api.service`
- `prosody.service`
- `minio.service`
- `nginx.service`
- `postgresql.service`
- `redis-server.service`

## Security controls
- UFW allow-list
- fail2ban (`sshd` + `liaot-api`)
- API login rate limit (app + nginx)
- Non-root service users for API/MinIO
