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

# What a deploy did to the checkout, said out loud — including when the
# answer is "nothing". See git-report.sh for the incident behind this.
# shellcheck source=/dev/null
. "${APP_DIR}/deploy/service/git-report.sh"
BEFORE_BRANCH=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
BEFORE_SHA=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')
echo "==> Starting from $(git_state "$APP_DIR")"

echo "==> Backing up first"
"${APP_DIR}/deploy/service/backup.sh"

echo "==> Fetching"
git -C "$APP_DIR" fetch --all --prune
if [ -n "$REF" ]; then git -C "$APP_DIR" checkout "$REF"; fi
git -C "$APP_DIR" pull --ff-only
# `|| MOVED=no` rather than letting set -e kill the run: an unchanged
# checkout is a legitimate rebuild, not a failure. It is reported, and
# reported again at the end so it survives a tailed log.
MOVED=yes
report_git_change "$APP_DIR" "$BEFORE_BRANCH" "$BEFORE_SHA" || MOVED=no

echo "==> Rebuilding"
(cd "${APP_DIR}/server" && npm ci --omit=dev --no-audit --no-fund)
# VITE_API_URL stays UNSET on purpose — see install.sh and
# frontend/src/utils/api.jsx. Setting it bakes an absolute https:// API
# hostname into the bundle instead of the relative /api/v1 nginx proxies.
(cd "${APP_DIR}/frontend" && unset VITE_API_URL && npm ci --no-audit --no-fund && npm run build)

# Build into place only after the build SUCCEEDS. Building straight into
# the web root would leave the site half-replaced if vite failed.
rsync -a --delete "${APP_DIR}/frontend/dist/" "${WEB_ROOT}/"
# root:root — the same account install.sh installs under and the same
# one agentic-pms-api.service starts as. All three are written out in
# full; they must be changed together or the service loses access to
# its own files.
chown -R root:root "${APP_DIR}/server"

echo "==> Restarting"
systemctl restart agentic-pms-api
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1/api/v1/health >/dev/null 2>&1; then
    # The summary rides on the SAME line as the success, because
    # "==> Healthy." on its own is exactly what made a no-op deploy look
    # like a real one.
    if [ "$MOVED" = yes ]; then
      echo "==> Healthy. Deployed ${BEFORE_SHA} -> $(git -C "$APP_DIR" rev-parse --short HEAD) on ${BEFORE_BRANCH}."
    else
      echo "==> Healthy — but NOTHING NEW was deployed: still at ${BEFORE_SHA} on ${BEFORE_BRANCH}."
    fi
    exit 0
  fi
  sleep 2
done
echo "!! The API did not come back within 90s. Last 40 lines:" >&2
journalctl -u agentic-pms-api -n 40 --no-pager >&2
exit 1
