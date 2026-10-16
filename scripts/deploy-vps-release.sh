#!/usr/bin/env bash
set -euo pipefail

# Release layout used by rabisuB. Run as root after /opt/lyaotalk-src has
# fast-forwarded to the requested commit. Matrix services are never touched.
src=/opt/lyaotalk-src
releases=/opt/lyaotalk-releases
current=/opt/lyaotalk-current
sha="${1:-}"

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a full commit SHA" >&2; exit 1; }
[[ -d "$src/.git" && -f /etc/lyaotalk/api.env && -x /usr/local/sbin/lyaotalk-backup ]] || {
  echo "LyaoTalk release host prerequisites missing" >&2; exit 1;
}
[[ "$(git -C "$src" rev-parse HEAD)" == "$sha" ]] || { echo "Source checkout is not at requested SHA" >&2; exit 1; }
[[ -z "$(git -C "$src" status --porcelain)" ]] || { echo "Source checkout has changes" >&2; exit 1; }
[[ -L "$current" ]] || { echo "Current release symlink missing" >&2; exit 1; }
previous="$(realpath "$current")"
[[ "$previous" == "$releases/"* && -d "$previous" ]] || { echo "Unexpected current release" >&2; exit 1; }
target="$releases/$sha"
[[ ! -e "$target" ]] || { echo "Target release already exists" >&2; exit 1; }

mkdir -m 755 "$target"
rsync -a --exclude=.git --exclude=node_modules --exclude=dist --exclude=.env \
  "$src/" "$target/"
bash -n "$target/install.sh" "$target/manage.sh" "$target/scripts/deploy-vps-release.sh"
python3 -m compileall -q "$target/apps/api/app" "$target/configs/prosody"

# A shared venv can serve either release only when package requirements match.
if ! diff -q <(grep -v '^[[:space:]]*#' "$previous/apps/api/requirements.txt") \
             <(grep -v '^[[:space:]]*#' "$target/apps/api/requirements.txt") >/dev/null; then
  echo "Python requirements changed; prepare a new venv before deployment" >&2
  exit 1
fi

npm --prefix "$target/apps/web" ci --no-audit --no-fund
npm --prefix "$target/apps/web" test
npm --prefix "$target/apps/web" run build

/usr/local/sbin/lyaotalk-backup
systemd-run --wait --collect --pipe \
  --property=EnvironmentFile=/etc/lyaotalk/api.env \
  --property=WorkingDirectory="$target/apps/api" \
  /opt/lyaotalk-venv/bin/alembic upgrade head

rollback() {
  ln -s "$previous" "$current.rollback"
  mv -Tf "$current.rollback" "$current"
  systemctl restart lyaotalk-api
  echo "Release rollback restored $previous; inspect database migration compatibility" >&2
}
trap rollback ERR
ln -s "$target" "$current.next"
mv -Tf "$current.next" "$current"
systemctl restart lyaotalk-api
systemctl restart lyaotalk-prosody.socket
nginx -t
systemctl reload nginx
healthy=false
for attempt in {1..15}; do
  if curl --fail --silent --max-time 5 https://lyaot.2-yc.com/api/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
[[ "$healthy" == true ]] || { echo "API health check failed after startup grace period" >&2; exit 1; }
systemctl is-active --quiet lyaotalk-api prosody lyaotalk-minio lyaotalk-redis matrix-synapse mas
trap - ERR
printf 'Deployed LyaoTalk %s; Matrix healthy\n' "$sha"
