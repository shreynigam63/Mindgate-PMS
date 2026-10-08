#!/usr/bin/env bash
# Agentic PMS — deploy a new version (native/systemd deployment).
#
#   sudo /opt/agentic-pms/deploy/service/update.sh [branch] [commit]
#
#   branch  the branch this box tracks (default: the one it is on)
#   commit  the exact commit to deploy (default: the tip of that branch).
#           The GitHub deploy always passes it: it deploys the commit its
#           tests passed on, not whatever main happens to be by then.
#
# Takes a backup FIRST, because the new version may bring migrations and a
# migration is the one change on this box that a restart cannot undo.
#
# THE SCREENS ARE NOT BUILT HERE (since 8 Oct). Building the frontend on
# this small instance is the likeliest reason a deploy took the PoC down
# for about seven hours — the box stopped answering mid-deploy. GitHub
# Actions builds the bundle and publishes it per commit (see
# web-bundle.sh); this script downloads it BEFORE it touches anything, so
# a missing bundle stops the deploy with the box exactly as it was.
# Building here is still possible, deliberately, for when GitHub is not
# an option: run with BUILD_ON_BOX=1.
set -euo pipefail

# Overridable ONLY so server/test/deploy-web-bundle.test.js can run this very
# script against temporary repositories. Nothing on the box sets them.
APP_DIR="${APMS_APP_DIR:-/opt/agentic-pms}"
WEB_ROOT="${APMS_WEB_ROOT:-/var/www/agentic-pms}"
REF="${1:-}"
WANT="${2:-}"
# The helpers come from the directory this script is in, not from
# APP_DIR. The GitHub deploy runs this script from a copy taken from the
# commit being deployed, so a change to the deploy scripts takes effect in
# the deploy that ships it rather than one deploy later.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run with sudo." >&2; exit 1; }
[ -d "${APP_DIR}/.git" ] || { echo "ERROR: ${APP_DIR} is not a git checkout.
This installation was copied from a checkout elsewhere; update that checkout
and re-run its deploy/service/install.sh, which is also the upgrade path." >&2; exit 1; }

# What a deploy did to the checkout, said out loud — including when the
# answer is "nothing". See git-report.sh for the incident behind this.
# shellcheck source=/dev/null
. "${HERE}/git-report.sh"
# shellcheck source=/dev/null
. "${HERE}/web-bundle.sh"
BEFORE_BRANCH=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
BEFORE_SHA=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')
BEFORE_FULL=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo '')
echo "==> Starting from $(git_state "$APP_DIR")"

echo "==> Backing up first"
"${HERE}/backup.sh"

echo "==> Fetching"
git -C "$APP_DIR" fetch --all --prune
if [ -n "$REF" ]; then git -C "$APP_DIR" checkout "$REF"; fi
UPSTREAM=$(git -C "$APP_DIR" rev-parse --verify -q '@{u}' || true)
TARGET=$(git -C "$APP_DIR" rev-parse --verify -q "${WANT:-${UPSTREAM:-HEAD}}^{commit}" || true)
[ -n "$TARGET" ] || { echo "ERROR: ${WANT:-the branch tip} is not a commit this checkout can see." >&2; exit 1; }
# Forward only, along the branch being deployed. A commit that is not on
# it is refused; a commit the box is already past is not deployed
# backwards — re-running an old deploy must not roll the box back.
if [ -n "$UPSTREAM" ] && ! git -C "$APP_DIR" merge-base --is-ancestor "$TARGET" "$UPSTREAM"; then
  echo "ERROR: ${TARGET:0:7} is not on $(git -C "$APP_DIR" rev-parse --abbrev-ref '@{u}')." >&2; exit 1
fi
if [ "$TARGET" != "$BEFORE_FULL" ] && git -C "$APP_DIR" merge-base --is-ancestor "$TARGET" HEAD; then
  echo "==> This box is already past ${TARGET:0:7}; it stays where it is."
  TARGET="$BEFORE_FULL"
fi

# The screens, BEFORE anything moves: if there is no bundle for this
# commit, stop now, with the checkout, the dependencies and the running
# service all untouched.
WEB_TMP=$(mktemp -d)
trap 'rm -rf "$WEB_TMP"' EXIT
WEB_SRC=""
echo "==> Fetching the screens for ${TARGET:0:7}"
if fetch_web_bundle "$APP_DIR" "$TARGET" "$WEB_TMP"; then
  WEB_SRC="$WEB_TMP"
elif [ "${BUILD_ON_BOX:-}" = 1 ]; then
  echo "==> BUILD_ON_BOX=1 — the screens will be built on this box instead."
else
  echo "!! Stopping before any change. Either:" >&2
  echo "!!   - let the GitHub deploy run for this commit (it publishes the bundle first), or" >&2
  echo "!!   - run again with BUILD_ON_BOX=1 to build on this box (heavy on a small instance)." >&2
  exit 1
fi

git -C "$APP_DIR" merge --ff-only -q "$TARGET"
# `|| MOVED=no` rather than letting set -e kill the run: an unchanged
# checkout is a legitimate rebuild, not a failure. It is reported, and
# reported again at the end so it survives a tailed log.
MOVED=yes
report_git_change "$APP_DIR" "$BEFORE_BRANCH" "$BEFORE_SHA" || MOVED=no

echo "==> Server dependencies"
# Reinstalled only when they changed, or are missing. npm ci is the other
# heavy step on this box, and most deploys change no dependency at all.
if [ -d "${APP_DIR}/server/node_modules" ] && [ -n "$BEFORE_FULL" ] \
   && git -C "$APP_DIR" diff --quiet "$BEFORE_FULL" HEAD -- server/package.json server/package-lock.json; then
  echo "    unchanged — not reinstalled"
else
  (cd "${APP_DIR}/server" && npm ci --omit=dev --no-audit --no-fund)
fi

if [ -z "$WEB_SRC" ]; then
  echo "==> Building the screens on this box (BUILD_ON_BOX=1)"
  # VITE_API_URL stays UNSET on purpose — see install.sh and
  # frontend/src/utils/api.jsx. Setting it bakes an absolute https:// API
  # hostname into the bundle instead of the relative /api/v1 nginx proxies.
  (cd "${APP_DIR}/frontend" && unset VITE_API_URL && npm ci --no-audit --no-fund && npm run build)
  WEB_SRC="${APP_DIR}/frontend/dist"
fi

# Into place only now, after everything above succeeded. A failure
# earlier leaves the site serving what it was.
rsync -a --delete "${WEB_SRC}/" "${WEB_ROOT}/"
prune_local_web_bundles "$APP_DIR" "$TARGET"
# root:root — the same account install.sh installs under and the same
# one agentic-pms-api.service starts as. All three are written out in
# full; they must be changed together or the service loses access to
# its own files.
chown -R root:root "${APP_DIR}/server" "${WEB_ROOT}"

# Repo-owned, NON-SECRET settings (currently just AI_MODEL) are pushed
# into the instance env file here, BEFORE the restart, so the service
# comes back on the value the repository says rather than one deploy
# later. Secrets are refused by name inside the script — api.env stays the
# instance's, which is why it is otherwise never touched.
echo "==> Reconciling managed settings"
"${HERE}/reconcile-settings.sh" /etc/agentic-pms/api.env

echo "==> Restarting"
systemctl restart agentic-pms-api
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1/api/v1/health >/dev/null 2>&1; then
    # What nginx is actually SERVING, against what was just installed.
    # Asked after "I ran it, deployment is not reflected": a healthy API
    # proves nothing about the screens. If these differ the web root or
    # the nginx site is not the one this script writes to, and saying so
    # here beats a browser hard-refresh that cannot fix it.
    BUILT=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "${WEB_SRC}/index.html" | head -1 || true)
    SERVED=$(curl -fsS http://127.0.0.1/ 2>/dev/null | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1 || true)
    if [ -n "$BUILT" ] && [ "$BUILT" != "$SERVED" ]; then
      echo "!! nginx is serving ${SERVED:-nothing recognisable} but this build is ${BUILT}." >&2
      echo "!! The site root is not ${WEB_ROOT}, or nginx is serving another site. Check: nginx -T | grep -n root" >&2
      exit 1
    fi
    echo "==> Serving ${SERVED} (API build $(curl -fsS http://127.0.0.1/api/v1/health | grep -o '"build":"[^"]*"' || echo 'unknown'))."
    echo "==> Open tabs pick this up on their own; a tab older than this deploy shows a 'Reload' bar."
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
