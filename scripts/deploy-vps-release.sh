#!/usr/bin/env bash
set -euo pipefail

# Release layout used by rabisuB. Run as root after /opt/lyaotalk-src has
# fast-forwarded to the requested commit. Matrix services are never touched.
src=/opt/lyaotalk-src
releases=/opt/lyaotalk-releases
current=/opt/lyaotalk-current
push_module=/usr/lib/prosody-modules/mod_lyaotalk_push.lua
service_override=/etc/systemd/system/lyaotalk-api.service.d/30-release-venv.conf
default_venv=/opt/lyaotalk-venv
active_venv="$default_venv"
if [[ -f "$service_override" ]]; then
  active_venv="$(sed -n 's|^ExecStart=\(/opt/lyaotalk-venv-[^/]*\)/bin/uvicorn .*|\1|p' "$service_override" | tail -n 1)"
  [[ -n "$active_venv" ]] || { echo "Unexpected API venv override" >&2; exit 1; }
fi
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
luac -p "$target/configs/prosody/mod_lyaotalk_push.lua"
[[ -f "$push_module" ]] || { echo "Prosody push module missing" >&2; exit 1; }
cp -p "$push_module" "$target/.previous-push-module.lua"

# A shared venv can serve either release only when package requirements match.
release_venv="$active_venv"
venv_changed=false
if ! diff -q <(grep -v '^[[:space:]]*#' "$previous/apps/api/requirements.txt") \
             <(grep -v '^[[:space:]]*#' "$target/apps/api/requirements.txt") >/dev/null; then
  release_venv="/opt/lyaotalk-venv-$sha"
  [[ -x "$release_venv/bin/python" && -x "$release_venv/bin/alembic" && -x "$release_venv/bin/uvicorn" ]] || {
    echo "Python requirements changed; prepare $release_venv before deployment" >&2; exit 1;
  }
  "$release_venv/bin/python" -m pip check
  venv_changed=true
fi

npm --prefix "$target/apps/web" ci --no-audit --no-fund
npm --prefix "$target/apps/web" test
npm --prefix "$target/apps/web" run build

/usr/local/sbin/lyaotalk-backup
systemd-run --wait --collect --pipe \
  --property=EnvironmentFile=/etc/lyaotalk/api.env \
  --property=WorkingDirectory="$target/apps/api" \
  "$release_venv/bin/alembic" upgrade head

# Older release hosts run the API with ProtectSystem=strict but without a
# writable private /tmp. Starlette's multipart parser rolls uploads to a
# temporary file above 1 MiB and otherwise returns HTTP 400 before auth.
install -d -m 755 /etc/systemd/system/lyaotalk-api.service.d
printf '[Service]\nPrivateTmp=yes\n' > /etc/systemd/system/lyaotalk-api.service.d/20-private-tmp.conf
previous_override="$(mktemp)"
override_existed=false
if [[ -f "$service_override" ]]; then
  cp -p "$service_override" "$previous_override"
  override_existed=true
fi
systemctl daemon-reload

rollback() {
  if [[ "$override_existed" == true ]]; then
    cp -p "$previous_override" "$service_override"
  else
    rm -f "$service_override"
  fi
  systemctl daemon-reload
  ln -s "$previous" "$current.rollback"
  mv -Tf "$current.rollback" "$current"
  install -m 644 "$target/.previous-push-module.lua" "$push_module"
  systemctl restart prosody
  systemctl restart lyaotalk-api
  echo "Release rollback restored $previous; inspect database migration compatibility" >&2
}
trap rollback ERR
if [[ "$venv_changed" == true ]]; then
  printf '[Service]\nExecStart=\nExecStart=%s/bin/uvicorn app.main:app --host 127.0.0.1 --port 18000 --workers 2 --proxy-headers --forwarded-allow-ips 127.0.0.1\n' "$release_venv" > "$service_override"
  systemctl daemon-reload
fi
ln -s "$target" "$current.next"
mv -Tf "$current.next" "$current"
install -m 644 "$target/configs/prosody/mod_lyaotalk_push.lua" "$push_module"
systemctl restart lyaotalk-api
systemctl restart prosody
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
systemctl is-active --quiet lyaotalk-api prosody lyaotalk-minio lyaotalk-redis nginx postgresql@14-main coturn

# An unauthenticated 2 MiB upload must reach auth (401). A 400 here means
# multipart spooling failed before the route was entered.
probe_file="$(mktemp)"
truncate -s 2M "$probe_file"
probe_status="$(curl --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' \
  -F "file=@${probe_file};type=video/webm" http://127.0.0.1:18000/attachments/upload)"
rm -f "$probe_file"
[[ "$probe_status" == 401 ]] || { echo "Multipart upload smoke check failed: HTTP $probe_status" >&2; exit 1; }

trap - ERR
rm -f "$previous_override"
# Keep the release window bounded: every release carries its own
# apps/web/node_modules (~350 MB), so unpruned growth fills the disk.
/usr/local/sbin/lyaotalk-prune-releases --apply >>/var/log/lyaotalk-prune.log 2>&1 || true
printf 'Deployed LyaoTalk %s; LyaoTalk services healthy\n' "$sha"
