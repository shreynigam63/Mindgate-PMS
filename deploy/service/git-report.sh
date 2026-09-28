#!/usr/bin/env bash
# What a deploy did to the checkout — said out loud, including when the
# answer is "nothing".
#
# Asked for on 28 Sep: "please fix update.sh to report before and after
# commit."
#
# THE INCIDENT THIS COMES FROM. A change was committed to main; the box
# tracks a feature branch, so `git pull` brought nothing. update.sh
# rebuilt identical code, restarted, printed "==> Healthy." and exited
# 0. Every word of that was true and the deploy had done nothing. The
# same run had already chowned a file to the new service account, so
# the box was left one restart away from failing to boot, and the only
# clue was a unit file that still named the old user.
#
# A deploy script that cannot distinguish "nothing to do" from "nothing
# happened" is a deploy script that lies by omission. Both lines below
# exist so that a person reading the tail of the output can tell which
# one they got.
#
# Sourced by update.sh. Kept separate so it can be tested against real
# temporary repositories without running the parts that need root,
# systemd and a live database — see server/test/deploy-git-report.test.js.

# git_state <dir> — "<branch> <short-sha> <subject>" on one line.
# Branch is included because the branch was the whole cause: "at
# c807824" told nobody that c807824 was the tip of the wrong branch.
git_state() {
  local dir="$1"
  local branch sha subject
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
  sha=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo '?')
  subject=$(git -C "$dir" log -1 --format=%s 2>/dev/null || echo '?')
  printf '%s %s %s' "$branch" "$sha" "$subject"
}

# report_git_change <dir> <before-branch> <before-sha> — prints the
# before/after block and returns 0 if the checkout moved, 1 if it did
# not.
#
# The return code is NOT an error. Re-running a deploy to rebuild the
# same commit is a legitimate thing to do; the caller decides. What is
# not legitimate is doing it silently.
report_git_change() {
  local dir="$1" before_branch="$2" before_sha="$3"
  local after_branch after_sha after_subject
  after_branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
  after_sha=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo '?')
  after_subject=$(git -C "$dir" log -1 --format=%s 2>/dev/null || echo '?')

  echo "    branch: ${after_branch}"
  echo "    before: ${before_sha}"
  echo "    after:  ${after_sha} — ${after_subject}"

  if [ "$before_branch" != "$after_branch" ]; then
    echo "    (branch changed from ${before_branch})"
  fi

  if [ "$before_sha" = "$after_sha" ]; then
    # Loud, and it names the likeliest cause rather than leaving the
    # reader to work out what an unchanged sha means.
    echo "!!  NOTHING NEW — the checkout did not move."
    echo "!!  This rebuilds and restarts the SAME code. If you expected a"
    echo "!!  change, check that it is on '${after_branch}' — the branch this"
    echo "!!  box tracks — and not only on another branch."
    return 1
  fi
  return 0
}
