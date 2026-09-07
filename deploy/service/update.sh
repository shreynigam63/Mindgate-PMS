#!/usr/bin/env bash
# Agentic PMS — deploy a new version (native/systemd deployment).
#
#   sudo /opt/agentic-pms/deploy/service/update.sh [git-ref]
#
# Pulls, rebuilds and restarts. Takes a backup FIRST, because the new
# version may bring migrations and a migration is the one change on this
# box that a restart cannot undo.
set -euo pipefail

APP_DIR=/opt/agentic-pms
WEB_ROOT=/var/www/agentic-pms
REF="${1:-}"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run with sudo." >&2; exit 1; }
[ -d "${APP_DIR}/.git" ] || { echo "ERROR: ${APP_DIR} is not a git checkout.
This installation was copied from a checkout elsewhere; update that checkout
and re-run its deploy/service/install.sh, which is also the upgrade path." >&2; exit 1; }

echo "==> Backing up first"
"${APP_DIR}/deploy/service/backup.sh"

echo "==> Fetching"
git -C "$APP_DIR" fetch --all --prune
if [ -n "$REF" ]; then git -C "$APP_DIR" checkout "$REF"; fi
git -C "$APP_DIR" pull --ff-only
echo "    now at $(git -C "$APP_DIR" rev-parse --short HEAD) — $(git -C "$APP_DIR" log -1 --format=%s)"

echo "==> Rebuilding"
(cd "${APP_DIR}/server" && npm ci --omit=dev --no-audit --no-fund)
# VITE_API_URL stays UNSET on purpose — see install.sh and
# frontend/src/utils/api.jsx. Setting it bakes an absolute https:// API
# hostname into the bundle instead of the relative /api/v1 nginx proxies.
(cd "${APP_DIR}/frontend" && unset VITE_API_URL && npm ci --no-audit --no-fund && npm run build)

# Build into place only after the build SUCCEEDS. Building straight into
# the web root would leave the site half-replaced if vite failed.
rsync -a --delete "${APP_DIR}/frontend/dist/" "${WEB_ROOT}/"
chown -R apms:apms "${APP_DIR}/server"

echo "==> Restarting"
systemctl restart agentic-pms-api
for i in $(seq 1 45); do
  curl -fsS http://127.0.0.1/api/v1/health >/dev/null 2>&1 && { echo "==> Healthy."; exit 0; }
  sleep 2
done
echo "!! The API did not come back within 90s. Last 40 lines:" >&2
journalctl -u agentic-pms-api -n 40 --no-pager >&2
exit 1
