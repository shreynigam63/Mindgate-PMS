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
LOCK="${APMS_LOCK:-/run/agentic-pms-deploy.lock}"
REF="${1:-}"
WANT="${2:-}"
# The helpers come from the directory this script is in, not from
# APP_DIR. The GitHub deploy runs this script from a copy taken from the
# commit being deployed, so a change to the deploy scripts takes effect in
# the deploy that ships it rather than one deploy later. They are run with
# `bash`, not executed, so a /tmp mounted noexec does not stop them.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run with sudo." >&2; exit 1; }
[ -d "${APP_DIR}/.git" ] || { echo "ERROR: ${APP_DIR} is not a git checkout.
This installation was copied from a checkout elsewhere; update that checkout
and re-run its deploy/service/install.sh, which is also the upgrade path." >&2; exit 1; }

# ONE DEPLOY AT A TIME, on the box itself. The workflow's concurrency
# group only covers runs it knows about: not a deploy run by hand, and not
# one still running here after the workflow gave up polling it. Two at once
# would fight over the checkout, node_modules, the web root and the
# restart. A second one waits for the first, then sees what it did.
exec 9>"$LOCK"
if ! flock -w "${APMS_LOCK_WAIT:-600}" 9; then
  echo "!! Another deploy has held ${LOCK} for ${APMS_LOCK_WAIT:-600}s and is still running. Check: ps aux | grep update.sh" >&2
  exit 1
fi

# What a deploy did to the checkout, said out loud — including when the
# answer is "nothing". See git-report.sh for the incident behind this.
# shellcheck source=/dev/null
. "${HERE}/git-report.sh"
# shellcheck source=/dev/null
. "${HERE}/web-bundle.sh"
g() { git -C "$APP_DIR" "$@"; }
# The last commit a deploy FINISHED — healthy API, the right screens
# served. HEAD alone cannot say that: it moves before the packages, the
# screens and the restart, so after a deploy that failed half-way HEAD is
# a commit that never went live.
DEPLOYED_FILE="$(g rev-parse --absolute-git-dir)/apms-deployed"
LAST_DEPLOYED=$(cat "$DEPLOYED_FILE" 2>/dev/null || true)
BEFORE_BRANCH=$(g rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
BEFORE_SHA=$(g rev-parse --short HEAD 2>/dev/null || echo '?')
BEFORE_FULL=$(g rev-parse HEAD 2>/dev/null || echo '')
echo "==> Starting from $(git_state "$APP_DIR")"

echo "==> Backing up first"
bash "${HERE}/backup.sh"

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
# Where this box last stood on that branch: HEAD, or — when switching to
# it — the box's own copy of it, if it ever ran it. Forward only, from
# there, whichever way the box arrives.
if [ "$SWITCH" = no ]; then CUR="$BEFORE_FULL"; else CUR=$(g rev-parse -q --verify "refs/heads/${BRANCH}" || true); fi
if [ -n "$CUR" ]; then
  # origin's branch no longer contains what the box ran: it was rewound
  # (a force-push to roll back), or the box has commits of its own.
  # Either way not a fast-forward, and never rolled back automatically.
  if ! g merge-base --is-ancestor "$CUR" "$TIP"; then
    echo "ERROR: this box's ${BRANCH} (${CUR:0:7}) is not on origin/${BRANCH} (${TIP:0:7}) — origin was rewound below it, or the box has commits of its own." >&2
    echo "       Not rolled back automatically: a migration cannot be undone. To roll back, revert the change on ${BRANCH} instead." >&2
    echo "       To go back anyway, knowing the database is compatible: git -C ${APP_DIR} reset --hard origin/${BRANCH} (on ${BRANCH}), then deploy again." >&2
    exit 1
  fi
  if [ "$TARGET" != "$CUR" ] && g merge-base --is-ancestor "$TARGET" "$CUR"; then
    if [ "$SWITCH" = no ] && [ "$LAST_DEPLOYED" = "$CUR" ]; then
      # A re-run of an older deploy. Correct to do nothing, and nothing
      # is touched: no download, no settings, no restart.
      echo "==> Already past ${TARGET:0:7}: this box is at ${BEFORE_SHA} on ${BRANCH}, which includes it. Nothing deployed, nothing restarted."
      exit 0
    elif [ "$SWITCH" = no ]; then
      LAST_SHORT="${LAST_DEPLOYED:0:7}"
      echo "ERROR: this box is at ${BEFORE_SHA}, past ${TARGET:0:7} — but the deploy of ${BEFORE_SHA} never finished (last finished: ${LAST_SHORT:-none recorded})." >&2
      echo "       Its packages, screens or restart may be missing. Re-run the deploy of ${BEFORE_SHA}, or deploy something newer, to complete it." >&2
    else
      echo "ERROR: this box last ran ${BRANCH} at ${CUR:0:7}, past ${TARGET:0:7}. Deploys never go back — deploy ${BRANCH}'s tip instead." >&2
    fi
    exit 1
  fi
  if ! g merge-base --is-ancestor "$CUR" "$TARGET"; then
    echo "ERROR: ${TARGET:0:7} does not include ${CUR:0:7}, where this box last ran ${BRANCH} — they are on different lines of its history. Deploy origin/${BRANCH}'s tip instead." >&2
    exit 1
  fi
fi
# Local edits are said out loud now, not discovered half-way: the move
# carries them along, or stops if the new commit changes the same files.
DIRTY=$(g status --porcelain --untracked-files=no 2>/dev/null || true)
if [ -n "$DIRTY" ]; then
  echo "!! The checkout has local changes (git -C ${APP_DIR} diff to see them):" >&2
  printf '%s\n' "$DIRTY" | sed 's/^/!!   /' >&2
fi

# The screens. Downloaded — or, with BUILD_ON_BOX=1, built in a worktree
# of TARGET next to the checkout (not under /tmp, which may be noexec) —
# before anything moves.
WORK=$(mktemp -d)
BUILD_DIR=""
cleanup() {
  if [ -n "$BUILD_DIR" ]; then g worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true; rm -rf "$BUILD_DIR"; fi
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
  BUILD_DIR=$(mktemp -d "$(dirname "$APP_DIR")/.apms-build.XXXXXX")
  rmdir "$BUILD_DIR"
  g worktree add -q --detach "$BUILD_DIR" "$TARGET"
  # VITE_API_URL stays UNSET on purpose — see install.sh and
  # frontend/src/utils/api.jsx. Setting it bakes an absolute https:// API
  # hostname into the bundle instead of the relative /api/v1 nginx proxies.
  (cd "${BUILD_DIR}/frontend" && unset VITE_API_URL && npm ci --no-audit --no-fund && npm run build)
  WEB_SRC="${BUILD_DIR}/frontend/dist"
  check_web_bundle "$WEB_SRC" "$TARGET" || { echo "!! The build did not produce a complete bundle. Nothing was changed." >&2; exit 1; }
else
  echo "!! Stopping before any change. Either:" >&2
  echo "!!   - let the GitHub deploy run for this commit (it publishes the bundle once the tests pass), or" >&2
  echo "!!   - build on this box (heavy on a small instance), as root:" >&2
  if grep -q BUILD_ON_BOX "${APP_DIR}/deploy/service/update.sh" 2>/dev/null; then
    echo "!!       sudo BUILD_ON_BOX=1 ${APP_DIR}/deploy/service/update.sh ${BRANCH} ${TARGET}" >&2
  else
    # The box's own update.sh is the version this one replaces: it would
    # ignore BUILD_ON_BOX and build in place. Run this commit's instead.
    echo "!!       D=\$(mktemp -d) && git -C ${APP_DIR} archive ${TARGET} deploy/service | tar -x -C \"\$D\" && BUILD_ON_BOX=1 bash \"\$D/deploy/service/update.sh\" ${BRANCH} ${TARGET}" >&2
  fi
  exit 1
fi

# ---- Move.
if [ "$SWITCH" = yes ]; then
  echo "==> Switching from ${BEFORE_BRANCH} to ${BRANCH}"
  g checkout -q -B "$BRANCH" "$TARGET" \
    || { echo "!! Could not switch the checkout — see the local changes listed above. Nothing else was changed." >&2; exit 1; }
  g branch -q --set-upstream-to "origin/${BRANCH}"
else
  g merge --ff-only -q "$TARGET" \
    || { echo "!! Could not move the checkout — see the local changes listed above. Nothing else was changed." >&2; exit 1; }
fi
# `|| MOVED=no` rather than letting set -e kill the run: an unchanged
# checkout is a legitimate redeploy (it repairs the site and the
# packages), not a failure. It is reported, and reported again at the end
# so it survives a tailed log.
MOVED=yes
report_git_change "$APP_DIR" "$BEFORE_BRANCH" "$BEFORE_SHA" || MOVED=no

echo "==> Server dependencies"
# Reinstalled unless the installed set is the one the lock file describes:
# a stamp written AFTER a successful install (npm ci empties node_modules
# first, so a failed install leaves none), and npm's own check that what
# is installed satisfies package.json — which also catches a hand-cleaned
# node_modules that kept the stamp.
DEPS_SUM=$(cat "${APP_DIR}/server/package.json" "${APP_DIR}/server/package-lock.json" | sha256sum | cut -d' ' -f1)
DEPS_STAMP="${APP_DIR}/server/node_modules/.apms-installed"
if [ -f "$DEPS_STAMP" ] && [ "$(cat "$DEPS_STAMP")" = "$DEPS_SUM" ] \
   && (cd "${APP_DIR}/server" && npm ls --omit=dev --depth=0 >/dev/null 2>&1); then
  echo "    unchanged — not reinstalled"
else
  (cd "${APP_DIR}/server" && npm ci --omit=dev --no-audit --no-fund)
  echo "$DEPS_SUM" > "$DEPS_STAMP"
fi

# Repo-owned, NON-SECRET settings (currently just AI_MODEL) are pushed
# into the instance env file here, BEFORE the restart, so the service
# comes back on the value the repository says rather than one deploy
# later. Secrets are refused by name inside the script — api.env stays the
# instance's, which is why it is otherwise never touched. Before the
# screens, so a refusal here leaves the site as it was.
echo "==> Reconciling managed settings"
bash "${HERE}/reconcile-settings.sh" /etc/agentic-pms/api.env

# Into place only now, after everything above succeeded.
#   --chmod         rsync -a copies the SOURCE directory's mode onto the web
#                   root, and a mktemp directory is 0700: nginx's workers
#                   would get 403 on every page.
#   --checksum      git archive stamps every file with the bundle's commit
#                   time, and Vite's index.html is the same size from build
#                   to build (fixed-length hashes). rsync's default
#                   size+time check could skip the one file that names the
#                   new build.
#   --delay-updates new files land together at the end, and
#   --delete-after  the old ones go after that — so an interrupted copy
#                   never leaves an index.html naming assets not there yet.
rsync -a --checksum --delay-updates --delete-after --chmod=D755,F644 "${WEB_SRC}/" "${WEB_ROOT}/"
# root:root — the same account install.sh installs under and the same
# one agentic-pms-api.service starts as. All three are written out in
# full; they must be changed together or the service loses access to
# its own files.
chown -R root:root "${APP_DIR}/server" "${WEB_ROOT}"

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
      echo "!! Check what it gets: curl -sI http://127.0.0.1/ — and whether its workers can reach the files: namei -l ${WEB_ROOT}/index.html" >&2
      exit 1
    fi
    if [ "$BUILT" != "$SERVED" ]; then
      echo "!! nginx is serving ${SERVED} but this build is ${BUILT:-unreadable}." >&2
      echo "!! The site root is not ${WEB_ROOT}, or nginx is serving another site. Check: nginx -T | grep -n root" >&2
      exit 1
    fi
    # Finished: this is now the commit the box runs, for the next deploy's
    # "already past" decision.
    echo "$TARGET" > "$DEPLOYED_FILE"
    prune_local_web_bundles "$APP_DIR" "$TARGET" || true
    echo "==> Serving ${SERVED} (API build $(curl -fsS http://127.0.0.1/api/v1/health | grep -o '"build":"[^"]*"' || echo 'unknown'))."
    echo "==> Open tabs pick this up on their own; a tab older than this deploy shows a 'Reload' bar."
    # The summary rides on the SAME line as the success, because
    # "==> Healthy." on its own is exactly what made a no-op deploy look
    # like a real one.
    if [ "$MOVED" = yes ]; then
      echo "==> Healthy. Deployed ${BEFORE_SHA} -> $(g rev-parse --short HEAD) on ${BRANCH}."
    else
      echo "==> Healthy — but NOTHING NEW was deployed: still at ${BEFORE_SHA} on $(g rev-parse --abbrev-ref HEAD)."
    fi
    exit 0
  fi
  sleep 2
done
echo "!! The API did not come back within 90s. Last 40 lines:" >&2
journalctl -u agentic-pms-api -n 40 --no-pager >&2
exit 1
