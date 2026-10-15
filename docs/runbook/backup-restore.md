# LiaoT Backup and Restore Runbook

Version: 2.2.0 ops-runbook

A backup is only real after a restore test.

## 1. What must be backed up

- PostgreSQL database.
- `.env` and generated secrets.
- Prosody config and data.
- MinIO object data.
- Uploaded attachments.
- Nginx and systemd overrides.
- Release version and migration head.

## 2. Create backup

```bash
cd /opt/liaot-src
sudo ./manage.sh backup
```

If manual backup is required:

```bash
sudo -u postgres pg_dump -Fc liaot > liaot-$(date +%F).dump
sudo tar -czf liaot-config-$(date +%F).tar.gz /opt/liaot-src/.env /etc/prosody /etc/nginx/sites-enabled
```

## 3. Verify backup artifact

```bash
ls -lh /path/to/backup
sha256sum /path/to/backup/* > /path/to/backup/SHA256SUMS
```

Store checksums away from the server.

## 4. Restore drill on staging

Monthly drill:

```bash
# On a clean staging VM
sudo systemctl stop liaot-api prosody nginx minio || true
# restore database dump
sudo -u postgres createdb liaot_restore || true
sudo -u postgres pg_restore -d liaot_restore /path/to/liaot.dump
# restore config/data according to backup layout
```

Then verify:

- user count
- conversation count
- recent messages
- attachment open/download
- admin login
- API health

## 5. Production restore decision

Restore production only after identifying the incident type:

- bad application release: prefer rollback first.
- database corruption: restore database snapshot.
- server loss: use disaster recovery runbook.
- secret leak: rotate secrets before reconnecting users.

## 6. Evidence template

Record in the ops log:

```text
Date:
Operator:
Backup file:
SHA256:
Source version:
Target version:
Database migration head:
Restore duration:
Validation result:
Follow-up fixes:
```
