#!/usr/bin/env bash
# Agentic PMS — deploy a new version (native/systemd deployment).
#
#   sudo /opt/agentic-pms/deploy/service/update.sh [branch] [commit]
#
#   branch  the branch to deploy (default: the one the box is on). Only a
#           branch on origin — never a tag or a bare commit, which would
#           leave the box on a detached HEAD that later runs cannot move.
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
# web-bundle.sh); this script downloads it BEFORE it touches anything.
#
# EVERYTHING IS DECIDED BEFORE ANYTHING MOVES: which branch, which commit,
# whether it is forward, and the screens for it. Any "no" up to that point
# leaves the checkout, the packages, the site and the running API exactly
# as they were. Building here is still possible, deliberately, for when
# GitHub is not an option — run with BUILD_ON_BOX=1 — and even then the
# build happens in a separate worktree before anything moves.
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
g() { git -C "$APP_DIR" "$@"; }
BEFORE_BRANCH=$(g rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
BEFORE_SHA=$(g rev-parse --short HEAD 2>/dev/null || echo '?')
BEFORE_FULL=$(g rev-parse HEAD 2>/dev/null || echo '')
echo "==> Starting from $(git_state "$APP_DIR")"

echo "==> Backing up first"
"${HERE}/backup.sh"

echo "==> Fetching"
# --no-tags: the screens are published as tags, and auto-following them
# would keep every bundle this box ever deployed (see web-bundle.sh).
g fetch --all --prune --no-tags

# ---- Decide. Nothing from here down to "Move" changes anything.
BRANCH="${REF:-$BEFORE_BRANCH}"
if [ "$BRANCH" = HEAD ] || ! g show-ref --verify -q "refs/remotes/origin/${BRANCH}"; then
  echo "ERROR: '${BRANCH}' is not a branch on origin. A deploy follows a branch — name one, e.g. main." >&2
  exit 1
fi
TIP=$(g rev-parse "refs/remotes/origin/${BRANCH}")
TARGET=$(g rev-parse --verify -q "${WANT:-$TIP}^{commit}" || true)
[ -n "$TARGET" ] || { echo "ERROR: ${WANT} is not a commit this checkout can see." >&2; exit 1; }
if ! g merge-base --is-ancestor "$TARGET" "$TIP"; then
  echo "ERROR: ${TARGET:0:7} is not on origin/${BRANCH}." >&2; exit 1
fi
SWITCH=no
[ "$BRANCH" = "$BEFORE_BRANCH" ] || SWITCH=yes
if [ "$SWITCH" = no ] && [ -n "$BEFORE_FULL" ] && [ "$TARGET" != "$BEFORE_FULL" ]; then
  # Forward only, along the branch. Re-running an old deploy must not roll
  # the box back — and must not touch it at all: it says so and stops,
  # with no download, no settings change and no restart.
  if g merge-base --is-ancestor "$TARGET" "$BEFORE_FULL"; then
    echo "==> Already past ${TARGET:0:7}: this box is at ${BEFORE_SHA} on ${BRANCH}, which includes it. Nothing deployed, nothing restarted."
    exit 0
  fi
  # Neither ahead nor behind: the box's own branch has commits origin
  # does not. A fast-forward is impossible; say so now, not halfway.
  if ! g merge-base --is-ancestor "$BEFORE_FULL" "$TARGET"; then
    echo "ERROR: this box's ${BRANCH} (${BEFORE_SHA}) has diverged from ${TARGET:0:7} on origin/${BRANCH}." >&2
    echo "       Find out why before deploying; to discard the box's own commits: git -C ${APP_DIR} reset --hard origin/${BRANCH}" >&2
    exit 1
  fi
fi

# The screens. Downloaded — or, with BUILD_ON_BOX=1, built in a worktree
# of TARGET — before anything moves.
WORK=$(mktemp -d)
cleanup() {
  if [ -d "${WORK}/src" ]; then g worktree remove --force "${WORK}/src" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
  g worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT
WEB_SRC=""
echo "==> Fetching the screens for ${TARGET:0:7}"
if fetch_web_bundle "$APP_DIR" "$TARGET" "${WORK}/web"; then
  WEB_SRC="${WORK}/web"
elif [ "${BUILD_ON_BOX:-}" = 1 ]; then
  echo "==> BUILD_ON_BOX=1 — building the screens on this box, in a separate worktree"
  g worktree add -q --detach "${WORK}/src" "$TARGET"
  # VITE_API_URL stays UNSET on purpose — see install.sh and
  # frontend/src/utils/api.jsx. Setting it bakes an absolute https:// API
  # hostname into the bundle instead of the relative /api/v1 nginx proxies.
  (cd "${WORK}/src/frontend" && unset VITE_API_URL && npm ci --no-audit --no-fund && npm run build)
  WEB_SRC="${WORK}/src/frontend/dist"
  check_web_bundle "$WEB_SRC" "$TARGET" || { echo "!! The build did not produce a complete bundle. Nothing was changed." >&2; exit 1; }
else
  echo "!! Stopping before any change. Either:" >&2
  echo "!!   - let the GitHub deploy run for this commit (it publishes the bundle first), or" >&2
  echo "!!   - build on this box (heavy on a small instance):" >&2
  echo "!!       sudo BUILD_ON_BOX=1 ${APP_DIR}/deploy/service/update.sh ${BRANCH} ${TARGET}" >&2
  exit 1
fi

# ---- Move.
if [ "$SWITCH" = yes ]; then
  echo "==> Switching from ${BEFORE_BRANCH} to ${BRANCH}"
  g checkout -q -B "$BRANCH" "$TARGET"
  g branch -q --set-upstream-to "origin/${BRANCH}"
else
  g merge --ff-only -q "$TARGET"
fi
# `|| MOVED=no` rather than letting set -e kill the run: an unchanged
# checkout is a legitimate redeploy (it repairs the site and the
# packages), not a failure. It is reported, and reported again at the end
# so it survives a tailed log.
MOVED=yes
report_git_change "$APP_DIR" "$BEFORE_BRANCH" "$BEFORE_SHA" || MOVED=no

echo "==> Server dependencies"
# Reinstalled only when the installed set is not the one the lock file
# describes — judged by a stamp written AFTER a successful install, never
# by what the previous commit was. npm ci empties node_modules first, so a
# failed install leaves no stamp and the next run installs again.
DEPS_SUM=$(cat "${APP_DIR}/server/package.json" "${APP_DIR}/server/package-lock.json" | sha256sum | cut -d' ' -f1)
DEPS_STAMP="${APP_DIR}/server/node_modules/.apms-installed"
if [ -f "$DEPS_STAMP" ] && [ "$(cat "$DEPS_STAMP")" = "$DEPS_SUM" ]; then
  echo "    unchanged — not reinstalled"
else
  (cd "${APP_DIR}/server" && npm ci --omit=dev --no-audit --no-fund)
  echo "$DEPS_SUM" > "$DEPS_STAMP"
fi

# Into place only now, after everything above succeeded. A failure
# earlier leaves the site serving what it was.
#   --chmod     rsync -a copies the SOURCE directory's mode onto the web
#               root, and a mktemp directory is 0700: nginx's workers
#               would get 403 on every page.
#   --checksum  git archive stamps every file with the bundle's commit
#               time, and Vite's index.html is the same size from build to
#               build (fixed-length hashes). rsync's default size+time
#               check can then skip the one file that names the new build.
rsync -a --delete --checksum --chmod=D755,F644 "${WEB_SRC}/" "${WEB_ROOT}/"
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
BUILT=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "${WEB_SRC}/index.html" | head -1 || true)
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1/api/v1/health >/dev/null 2>&1; then
    # What nginx is actually SERVING, against what was just installed.
    # Asked after "I ran it, deployment is not reflected": a healthy API
    # proves nothing about the screens. If these differ the web root or
    # the nginx site is not the one this script writes to, and saying so
    # here beats a browser hard-refresh that cannot fix it.
    SERVED=$(curl -fsS http://127.0.0.1/ 2>/dev/null | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1 || true)
    if [ -z "$SERVED" ]; then
      echo "!! nginx answered / with an error, or with a page that is not this app." >&2
      echo "!! Check it can read ${WEB_ROOT} (ls -ld ${WEB_ROOT} — it must be 755), then: curl -sI http://127.0.0.1/" >&2
      exit 1
    fi
    if [ "$BUILT" != "$SERVED" ]; then
      echo "!! nginx is serving ${SERVED} but this build is ${BUILT:-unreadable}." >&2
      echo "!! The site root is not ${WEB_ROOT}, or nginx is serving another site. Check: nginx -T | grep -n root" >&2
      exit 1
    fi
    echo "==> Serving ${SERVED} (API build $(curl -fsS http://127.0.0.1/api/v1/health | grep -o '"build":"[^"]*"' || echo 'unknown'))."
    echo "==> Open tabs pick this up on their own; a tab older than this deploy shows a 'Reload' bar."
    # The summary rides on the SAME line as the success, because
    # "==> Healthy." on its own is exactly what made a no-op deploy look
    # like a real one.
    if [ "$MOVED" = yes ]; then
      echo "==> Healthy. Deployed ${BEFORE_SHA} -> $(g rev-parse --short HEAD) on ${BRANCH}."
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
