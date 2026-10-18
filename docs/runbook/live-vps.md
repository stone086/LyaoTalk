# LyaoTalk on rabisuB

The public XMPP domain is `lyaot.2-yc.com`; uploads and MUC use
`upload.lyaot.2-yc.com` and `conference.lyaot.2-yc.com`. Matrix was retired
on 2026-10-19; its former domain serves a retirement notice. PostgreSQL,
nginx, Prosody and coturn remain essential to LyaoTalk.

## Layout

- Source checkout: `/opt/lyaotalk-src`
- Immutable builds: `/opt/lyaotalk-releases/<git-sha>`
- Active release: `/opt/lyaotalk-current` symlink
- API environment: `/etc/lyaotalk/api.env` (root readable)
- Python environment: `/opt/lyaotalk-venv`
- Data: `/var/lib/lyaotalk`
- Encrypted backup job: `/usr/local/sbin/lyaotalk-backup`, daily at 03:15
- API, MinIO and Redis units: `lyaotalk-api`, `lyaotalk-minio`, `lyaotalk-redis`
- Prosody registration socket: `lyaotalk-prosody.socket`

## Update

Run `sudo bash /opt/lyaotalk-src/manage.sh update`. It fast-forwards the source
checkout, builds and tests a new release, makes an encrypted backup, applies
database migrations, switches the active symlink, then checks the new API and
LyaoTalk services. It updates the Prosody push module and restores the previous module if
the post-switch checks fail. The GitHub manual VPS release workflow uses the
same deploy script.
Python requirement changes require a separately prepared virtual environment;
the deploy script stops before switching releases in that case.

## Check and recover

Run `sudo bash /opt/lyaotalk-src/manage.sh status` and verify the public
`/api/health` response. The deploy script restores the previous release
symlink and restarts the API if its post-switch checks fail. Database schema
changes are not automatically reversed; restore the encrypted database backup
only after reviewing migration compatibility. Do not restore over live data
without a maintenance window.

Two ordinary test account credentials are in `/etc/lyaotalk/test-accounts.env`
(root only). Do not copy that file into the repository or logs.

## Native XMPP client file uploads

The rabisuB Prosody 0.11 instance serves XEP-0363 at
`upload.lyaot.2-yc.com` through Nginx `/upload/`. This is separate from
LyaoTalk Web's API/MinIO attachment storage. The one-time migration is
`scripts/enable-vps-xmpp-upload.sh`; it backs up the live Prosody and Nginx
configuration and checks both services before completing. Upload slots require
an authenticated XMPP session. Files are limited to 100 MiB and each account
has a 500 MiB quota; Prosody expires old uploads on the next slot request.
