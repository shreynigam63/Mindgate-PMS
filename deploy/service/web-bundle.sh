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
# (vite.config.js stamps it), which fetch_web_bundle checks as well. The
# workflow keeps the bundles for the last 30 commits on main and deletes
# the rest, so the tag list does not grow without bound.
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
  git -C "$repo" push -q origin "+${commit}:${WEB_BUILD_PREFIX}/${sha}"
  echo "==> Published the web bundle for ${sha:0:7} as ${WEB_BUILD_PREFIX}/${sha}"
}

# prune_remote_web_bundles <repo_dir> <keep_count> <branch> [extra_sha...]
# — deletes every web-build tag on origin except those for the last
# <keep_count> commits of origin/<branch> and any extra shas named. A
# re-run of a recent deploy still finds its bundle; nothing older is kept.
prune_remote_web_bundles() {
  local repo="$1" keep="$2" branch="$3"; shift 3
  local recent keepers stale
  # No history to judge by means nothing is deleted: an empty keep-list
  # would otherwise remove every bundle there is.
  recent=$(git -C "$repo" rev-list -n "$keep" "origin/${branch}" 2>/dev/null || true)
  if [ -z "$recent" ]; then echo "==> Kept every web bundle (origin/${branch} not readable here)."; return 0; fi
  keepers=$( { printf '%s\n' "$recent"; printf '%s\n' "$@"; } | sort -u)
  stale=$(git -C "$repo" ls-remote origin "${WEB_BUILD_PREFIX}/*" \
    | awk '{print $2}' | sed "s#^${WEB_BUILD_PREFIX}/##" \
    | grep -vxF -f <(printf '%s\n' "$keepers") || true)
  if [ -z "$stale" ]; then echo "==> No old web bundles to remove."; return 0; fi
  # One push, many deletions.
  # shellcheck disable=SC2046
  git -C "$repo" push -q origin $(printf ":${WEB_BUILD_PREFIX}/%s " $stale)
  echo "==> Removed $(printf '%s\n' "$stale" | wc -l | tr -d ' ') old web bundle(s)."
}

# fetch_web_bundle <app_dir> <sha> <out_dir> — downloads the bundle for
# <sha> and extracts it into <out_dir>. Returns 1, with the reason, when
# there is no bundle for that commit or it was not built from it. Changes
# nothing outside <out_dir> and the local ref it fetches into.
fetch_web_bundle() {
  local app="$1" sha="$2" out="$3"
  if ! git -C "$app" fetch -q --no-tags origin "+${WEB_BUILD_PREFIX}/${sha}:${LOCAL_WEB_PREFIX}/${sha}" 2>/dev/null; then
    echo "!! No prebuilt web bundle for ${sha:0:7} on GitHub (${WEB_BUILD_PREFIX}/${sha})." >&2
    return 1
  fi
  mkdir -p "$out"
  git -C "$app" archive "${LOCAL_WEB_PREFIX}/${sha}" | tar -x -C "$out"
  if [ ! -f "${out}/index.html" ]; then
    echo "!! The web bundle for ${sha:0:7} has no index.html." >&2
    return 1
  fi
  # The bundle names the commit it was built from (vite.config.js). A tag
  # pointing at another commit's screens is refused rather than served.
  # No closing quote: `rev-parse --short=7` gives MORE than 7 characters
  # when 7 would be ambiguous, so the stamp is "<sha's first 7>…".
  if ! grep -rqsF "\"${sha:0:7}" "${out}/assets"; then
    echo "!! The web bundle tagged ${sha:0:7} was not built from ${sha:0:7}." >&2
    return 1
  fi
  echo "==> Downloaded the web bundle for ${sha:0:7} (built in GitHub Actions)."
}

# prune_local_web_bundles <app_dir> <keep_sha> — drops the local copies of
# every bundle but the one just deployed. They are only needed once.
prune_local_web_bundles() {
  local app="$1" keep="$2" ref
  git -C "$app" for-each-ref --format='%(refname)' "${LOCAL_WEB_PREFIX}/" | while read -r ref; do
    [ "$ref" = "${LOCAL_WEB_PREFIX}/${keep}" ] || git -C "$app" update-ref -d "$ref"
  done
}
