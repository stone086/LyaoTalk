# Backup / Restore Drill Results

Status: PASS_DESTRUCTIVE_STAGING_RESTORE

## Drill summary

| Step | Result | Time | Evidence |
|---|---:|---:|---|
| Create staging test data | PASS | 2026-05-13 11:26 UTC | sentinel account/message/attachment rows plus MinIO object |
| Run backup | PASS | 2026-05-13 11:26 UTC | `/root/backups/db_20260513_192640.sql.gz.enc`, `/root/backups/minio_20260513_192640.tar.gz.enc` |
| Restore into staging | PASS | 2026-05-13 11:26 UTC | database drop/recreate plus MinIO data directory restore |
| Verify data integrity | PASS | 2026-05-13 11:28 UTC | restored user/message/attachment rows and uploaded object |
| Rollback drill | PASS | 2026-05-13 11:28 UTC | `/root/staging-drill/20260513T112640Z/backup-restore-drill-results.md` |

## 2026-05-13 destructive staging restore

Target: `https://staging.example.com`

Drill id: `staging-restore-20260513T112640Z`

```text
backup completed: 20260513_192640 (cipher=aes-256-cbc iter=600000)
/root/backups/db_20260513_192640.sql.gz.enc: OK
/root/backups/minio_20260513_192640.tar.gz.enc: OK
```

Restore actions:

```text
database dropped, recreated, and restored from encrypted backup
MinIO data directory restored from encrypted backup
pre_restore_minio_dir: /data/minio.pre-restore-20260513T112640Z
```

Validation:

```text
systemctl is-active postgresql minio prosody liaot-api nginx
active
active
active
active
active

curl http://127.0.0.1:8000/health
{"status":"ok","version":"2.3.5"}

account:
acct-staging-restore-20260513T112640Z|staging-restore-20260513T112640Z@staging.example.com

message:
msg-staging-restore-20260513T112640Z|restore drill message staging-restore-20260513T112640Z

attachment:
att-staging-restore-20260513T112640Z|drill/staging-restore-20260513T112640Z/upload.txt

upload object:
liaot staging restore drill staging-restore-20260513T112640Z
```

Result: PASS

## 2026-05-10 non-destructive run

```text
backup completed: 20260510_134040
db_20260510_134040.sql.gz.enc    5.2K
minio_20260510_134040.tar.gz.enc 9.6M
```

SHA-256:

```text
69e200e56eb838c33eb47684bff001a99753d25401c158fcfa9bf7a83a6495f2  /root/backups/db_20260510_134040.sql.gz.enc
9baae2cc729cb628cdd356814c63cfeeffa79036920550423233127a48676640  /root/backups/minio_20260510_134040.tar.gz.enc
```

Dry-run drill record:

```text
UTC: 2026-05-10T13:40:40Z
dry_run: 1
Commands:
- ./manage.sh backup
- ./manage.sh snapshot
Dry run only. No destructive command executed.
```

Destructive restore was intentionally not run on the current target. Complete it
only on disposable staging data.

## Commands

```bash
sudo ./manage.sh backup
sudo ./manage.sh snapshot
sudo bash scripts/backup_restore_drill.sh --dry-run
```

Use destructive restore only on staging.
