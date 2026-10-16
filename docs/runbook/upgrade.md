# LyaoTalk Upgrade Runbook

Version: 2.2.0 ops-runbook

## Golden rule

Upgrade only after a verified backup and a staging rehearsal.

## 1. Before upgrade

```bash
cd /opt/lyaotalk-src
sudo ./manage.sh status || true
sudo ./manage.sh backup
sudo ./manage.sh snapshot
```

Save the backup path and snapshot ID.

## 2. Stage the new release

```bash
cd /tmp
unzip lyaotalk-2.2.0-ops-runbook.zip
cd lyaotalk-2.2.0-ops-runbook
bash scripts/stage0_validate.sh --local
bash scripts/trusted_build_validate.sh --local
bash scripts/observability_validate.sh
bash scripts/performance_validate.sh
bash scripts/compatibility_chaos_validate.sh
bash scripts/ops_runbook_validate.sh
```

## 3. Upgrade

Use the project updater if available:

```bash
cd /opt/lyaotalk-src
sudo ./manage.sh update
```

If using a release zip manually, copy files only after a backup and preserve `.env`, uploaded data, MinIO data, and database credentials.

## 4. Post-upgrade checks

```bash
sudo nginx -t
sudo prosodyctl check config
sudo systemctl restart lyaotalk-api
sudo systemctl status lyaotalk-api prosody nginx minio --no-pager
curl -fsS https://YOUR_DOMAIN/api/health
curl -fsS http://127.0.0.1:8000/metrics | head
```

Then perform browser login, chat, upload, and admin panel checks.

## 5. Rollback

Rollback if any critical user path fails.

```bash
cd /opt/lyaotalk-src
sudo ./manage.sh rollback
```

After rollback, verify:

```bash
curl -fsS https://YOUR_DOMAIN/api/health
sudo journalctl -u lyaotalk-api -n 100 --no-pager
```

## 6. Release evidence

Append upgrade notes to `docs/release/<version>-validation-report.md` or your private ops log:

- release version
- backup path
- migration head before/after
- health-check results
- rollback decision
- operator name and timestamp
