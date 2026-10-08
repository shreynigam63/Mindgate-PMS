#!/usr/bin/env bash
# The screens are built in GitHub Actions, not on the instance.
#
# Asked for on 8 Oct, after a deploy took the PoC down for about seven
# hours: the instance stopped answering mid-deploy and never picked up the
# deploy command, and building the frontend on the same small box that
# serves the site was the likeliest cause. So the build moved: a GitHub
# Actions job runs `npm run build` and publishes the finished bundle; the
# box only downloads it.
#
# WHERE THE BUNDLE LIVES. In this repository, as a tag per commit:
#
#   refs/tags/web-build/<full commit sha>  ->  an orphan commit whose tree
#                                             IS the built dist/ folder
#
# The repository is public and the box already fetches from it, so this
# needs no new key, no bucket and no AWS permission. Git's own hashing is
# the integrity check, and the bundle carries the commit it was built from
# (vite.config.js stamps it), which check_web_bundle checks as well. The
# workflow keeps the bundles for the last 30 commits on main and deletes
# the rest, so the tag list does not grow without bound.
#
# The box never lets these tags into its own tag list: every fetch it
# makes is --no-tags. Git auto-follows a tag that points at an object the
# repository already has, so after one deploy a plain fetch would turn
# that bundle into a local tag, and every bundle ever deployed would stay
# on the box's disk for good.
#
# Sourced by update.sh (fetch) and by the deploy workflow (publish, prune).
# Kept separate so both halves can be tested against real temporary git
# repositories — see server/test/deploy-web-bundle.test.js.

WEB_BUILD_PREFIX="refs/tags/web-build"
LOCAL_WEB_PREFIX="refs/web-build"

# publish_web_bundle <repo_dir> <dist_dir> <sha> — commits <dist_dir> as an
# orphan tree and pushes it to origin as refs/tags/web-build/<sha>. Uses a
# throwaway index, so the repository's own index and working tree are left
# exactly as they were.
publish_web_bundle() {
  local repo="$1" dist="$2" sha="$3"
  [ -f "${dist}/index.html" ] || { echo "!! ${dist}/index.html is missing — nothing to publish." >&2; return 1; }
  local gitdir index tree commit
  gitdir=$(git -C "$repo" rev-parse --absolute-git-dir)
  index=$(mktemp)
  rm -f "$index"
  # Run from inside the bundle so "." means the bundle, whatever the
  # caller's directory. -f because dist/ is git-ignored in the repository.
  tree=$(cd "$dist" && GIT_INDEX_FILE="$index" git --git-dir="$gitdir" --work-tree=. add -A -f . \
    && GIT_INDEX_FILE="$index" git --git-dir="$gitdir" --work-tree=. write-tree)
  rm -f "$index"
  [ -n "$tree" ] || { echo "!! could not write the bundle tree" >&2; return 1; }
  commit=$(git -C "$repo" -c user.name='PMS build' -c user.email='build@invalid' \
    commit-tree --no-gpg-sign "$tree" -m "Web bundle for ${sha}")
  git -C "$repo" push -q origin "+${commit}:${WEB_BUILD_PREFIX}/${sha}" \
    || { echo "!! could not push ${WEB_BUILD_PREFIX}/${sha}" >&2; return 1; }
  echo "==> Published the web bundle for ${sha:0:7} as ${WEB_BUILD_PREFIX}/${sha}"
}

# prune_remote_web_bundles <repo_dir> <keep_count> <branch> [extra_sha...]
# — deletes every web-build tag on origin except those for the last
# <keep_count> commits of origin/<branch>, the tip of EVERY branch on
# origin (a manual deploy of another branch can be re-run), and any extra
# shas named. A re-run of a recent deploy still finds its bundle.
prune_remote_web_bundles() {
  local repo="$1" keep="$2" branch="$3"; shift 3
  local recent heads keepers stale
  # No history to judge by means nothing is deleted: an empty keep-list
  # would otherwise remove every bundle there is.
  recent=$(git -C "$repo" rev-list -n "$keep" "origin/${branch}" 2>/dev/null || true)
  if [ -z "$recent" ]; then echo "==> Kept every web bundle (origin/${branch} not readable here)."; return 0; fi
  heads=$(git -C "$repo" ls-remote origin 'refs/heads/*' 2>/dev/null | awk '{print $1}' || true)
  keepers=$( { printf '%s\n' "$recent"; printf '%s\n' "$heads"; printf '%s\n' "$@"; } | grep . | sort -u)
  stale=$(git -C "$repo" ls-remote origin "${WEB_BUILD_PREFIX}/*" \
    | awk '{print $2}' | sed "s#^${WEB_BUILD_PREFIX}/##" \
    | grep -vxF -f <(printf '%s\n' "$keepers") || true)
  if [ -z "$stale" ]; then echo "==> No old web bundles to remove."; return 0; fi
  # One push, many deletions.
  # shellcheck disable=SC2046
  git -C "$repo" push -q origin $(printf ":${WEB_BUILD_PREFIX}/%s " $stale) \
    || { echo "!! could not remove the old web bundles" >&2; return 1; }
  echo "==> Removed $(printf '%s\n' "$stale" | wc -l | tr -d ' ') old web bundle(s)."
}

# check_web_bundle <dir> <sha> — is <dir> a complete build of <sha>?
# Every check returns 1 with the reason; nothing here is left to errexit,
# because callers run it inside `if`, where bash switches errexit off for
# the whole function body.
#   * index.html is there and not empty;
#   * every /assets/ file index.html names is there and not empty — a
#     truncated download or extract would otherwise go live as a blank site;
#   * the bundle carries the commit it was built from (vite.config.js), so
#     a tag pointing at another commit's screens is refused, not served.
#     No closing quote: `rev-parse --short=7` gives MORE than 7 characters
#     when 7 would be ambiguous, so the stamp is "<sha's first 7>…".
check_web_bundle() {
  local dir="$1" sha="$2" ref missing=""
  if [ ! -s "${dir}/index.html" ]; then
    echo "!! The web bundle for ${sha:0:7} has no index.html, or an empty one." >&2
    return 1
  fi
  for ref in $(grep -o '/assets/[^"'"'"' >]*' "${dir}/index.html" | sort -u); do
    [ -s "${dir}${ref}" ] || missing="${missing} ${ref#/}"
  done
  if [ -n "$missing" ]; then
    echo "!! The web bundle for ${sha:0:7} is incomplete — missing or empty:${missing}" >&2
    return 1
  fi
  if ! grep -rqsF "\"${sha:0:7}" "${dir}/assets"; then
    echo "!! The web bundle tagged ${sha:0:7} was not built from ${sha:0:7}." >&2
    return 1
  fi
}

# fetch_web_bundle <app_dir> <sha> <out_dir> — downloads the bundle for
# <sha> and extracts it into <out_dir>. Returns 1, with the REAL reason,
# when it cannot: not on GitHub, or on GitHub but the download failed (and
# git's own message), or not a complete build of <sha>. Changes nothing
# outside <out_dir> and the local ref it fetches into.
#
# Called by update.sh while it holds the box-wide deploy lock, so a lock
# file on that ref can only be left over from a deploy that was killed
# mid-fetch, and is cleared. A copy already on this box (the bundle of the
# commit it runs, kept by prune_local_web_bundles) is used when GitHub no
# longer has the tag — a repair of the running commit still works after
# the workflow has pruned it.
fetch_web_bundle() {
  local app="$1" sha="$2" out="$3" err lock rc=0
  lock=$(git -C "$app" rev-parse --git-path "${LOCAL_WEB_PREFIX}/${sha}.lock")
  case "$lock" in /*) ;; *) lock="${app}/${lock}" ;; esac
  rm -f "$lock"
  if ! err=$(git -C "$app" fetch -q --no-tags origin "+${WEB_BUILD_PREFIX}/${sha}:${LOCAL_WEB_PREFIX}/${sha}" 2>&1); then
    if git -C "$app" show-ref --verify -q "${LOCAL_WEB_PREFIX}/${sha}"; then
      echo "==> GitHub did not hand over the bundle for ${sha:0:7}; using the copy already on this box."
    else
      git -C "$app" ls-remote --exit-code origin "${WEB_BUILD_PREFIX}/${sha}" >/dev/null 2>&1 || rc=$?
      if [ "$rc" = 2 ]; then
        echo "!! No prebuilt web bundle for ${sha:0:7} on GitHub (${WEB_BUILD_PREFIX}/${sha})." >&2
      else
        echo "!! Could not download the web bundle for ${sha:0:7} (${WEB_BUILD_PREFIX}/${sha}). git said:" >&2
        printf '%s\n' "${err:-(nothing)}" | sed 's/^/!!   /' >&2
      fi
      return 1
    fi
  fi
  mkdir -p "$out" || return 1
  if ! git -C "$app" archive "${LOCAL_WEB_PREFIX}/${sha}" | tar -x -C "$out"; then
    echo "!! Could not unpack the web bundle for ${sha:0:7} (disk full?)." >&2
    return 1
  fi
  check_web_bundle "$out" "$sha" || return 1
  echo "==> Downloaded the web bundle for ${sha:0:7} (built in GitHub Actions)."
}

# prune_local_web_bundles <app_dir> <keep_sha> — drops the local copies of
# every bundle but the one just deployed. They are only needed once. Also
# drops any web-build TAG on the box — one auto-followed by a fetch from
# before the fetches here were --no-tags.
prune_local_web_bundles() {
  local app="$1" keep="$2" ref
  git -C "$app" for-each-ref --format='%(refname)' "${LOCAL_WEB_PREFIX}/" "${WEB_BUILD_PREFIX}/" | while read -r ref; do
    [ "$ref" = "${LOCAL_WEB_PREFIX}/${keep}" ] || git -C "$app" update-ref -d "$ref"
  done
}
