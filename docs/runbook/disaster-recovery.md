# LyaoTalk Disaster Recovery Runbook

Version: 2.2.0 ops-runbook

Use this when the original server is lost or cannot be trusted.

## Recovery objectives

| Target | Goal |
|---|---:|
| RPO | last verified backup |
| RTO | document during each restore drill |
| First service restored | API health + admin login |
| Full service restored | chat, upload, XMPP, metrics |

## 1. Build a clean replacement server

- Install supported Ubuntu.
- Point DNS to the new server.
- Open 80/443.
- Upload release zip and backup artifacts.

## 2. Restore software

```bash
unzip lyaotalk-2.2.0-ops-runbook.zip
cd lyaotalk-2.2.0-ops-runbook
bash scripts/stage0_validate.sh --local
sudo LYAOTALK_DOMAIN=chat.example.com bash install.sh
```

Stop services before restoring data:

```bash
sudo systemctl stop lyaotalk-api prosody nginx minio
```

## 3. Restore data

- Restore `.env` or rotate secrets if compromise is suspected.
- Restore PostgreSQL dump.
- Restore MinIO objects and uploaded attachments.
- Restore Prosody data if required.

## 4. Start services

```bash
sudo systemctl start minio prosody lyaotalk-api nginx
sudo systemctl status minio prosody lyaotalk-api nginx --no-pager
```

## 5. Validate

```bash
curl -fsS https://chat.example.com/api/health
curl -fsS http://127.0.0.1:8000/metrics | head
sudo nginx -t
sudo prosodyctl check config
```

Manual checks:

- admin login
- normal user login
- recent conversations present
- file download works
- upload works
- XMPP reconnect works

## 6. Post-recovery tasks

- Rotate secrets if old server compromise is possible.
- Reissue TLS certificates if needed.
- Record restore duration and data loss window.
- Keep old server offline until forensic decision is made.
