# LyaoTalk Secrets Rotation Runbook

Version: 2.2.0 ops-runbook

## Rotation schedule

| Secret | Frequency | Impact |
|---|---:|---|
| JWT `SECRET_KEY` | 90 days or incident | all users must log in again |
| Admin password hash | 90 days or staff change | admin login changes |
| PostgreSQL password | 90 days | requires API restart |
| MinIO root password | 90 days | object storage clients need update |
| TURN secret | 90 days | active calls may drop |
| OIDC client secret | 365 days or IdP incident | SSO needs update |
| Prosody DH params | 365 days | Prosody restart |

## JWT secret rotation

```bash
openssl rand -hex 32 | sudo tee /tmp/lyaotalk-secret-new
sudo cp /opt/lyaotalk-src/.env /opt/lyaotalk-src/.env.$(date +%F-%H%M%S).bak
sudo sed -i "s/^SECRET_KEY=.*/SECRET_KEY=$(cat /tmp/lyaotalk-secret-new)/" /opt/lyaotalk-src/.env
sudo -u postgres psql lyaotalk -c "DELETE FROM refresh_tokens;"
sudo systemctl restart lyaotalk-api
```

Validate:

```bash
curl -fsS https://YOUR_DOMAIN/api/health
```

## Admin password hash rotation

Use the project-supported Argon2 generation path from the installer or a trusted Python snippet using the same password library configured by the project. Store only the hash in `.env`.

Then restart API and verify admin login.

## PostgreSQL password rotation

1. Create new password.
2. Update PostgreSQL role.
3. Update `.env` database URL/password.
4. Restart API.
5. Verify `/api/health` and alembic current.

## MinIO secret rotation

Plan downtime or maintenance window. Update MinIO credentials and project `.env`, then restart MinIO and API. Test upload and download.

## Backup encryption key rotation

- Decrypt old backups in an isolated environment.
- Re-encrypt with new key.
- Store new checksums.
- Keep old key only until the new backup restore drill passes.
