#!/usr/bin/env bash
# Push repository-owned, NON-SECRET settings into the instance env file.
#
# WHY THIS EXISTS. install.sh never overwrites /etc/agentic-pms/api.env,
# and update.sh never touches it — deliberately, because that file holds
# the Anthropic key, the database URL and the JWT secret, and a deploy
# that can rewrite those is a deploy that can lock everybody out.
#
# The cost of that rule was paid by the settings in the same file that are
# NOT secret. AI_MODEL is version-controlled by our own documentation, yet
# changing it in the repo and deploying did nothing at all, because the
# only copy that mattered was the one no deploy was allowed to reach. That
# is a silent no-op, which is the failure mode this codebase likes least.
#
# So: a named, non-secret allow-list is reconciled on every deploy, and
# everything else in api.env is left exactly as it was.
#
#   reconcile-settings.sh [ENV_FILE] [MANAGED_FILE]
#
# Idempotent. Prints one line per key, including when nothing changed —
# "already correct" is a result, not silence.
set -euo pipefail

ENV_FILE="${1:-/etc/agentic-pms/api.env}"
MANAGED_FILE="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/managed-settings.env}"

[ -f "$MANAGED_FILE" ] || { echo "ERROR: no managed settings file at ${MANAGED_FILE}" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "ERROR: no env file at ${ENV_FILE}" >&2; exit 1; }

# A key whose NAME looks like a credential is refused outright, whatever
# the managed file says. The managed file lives in the repository, so a
# secret-shaped name in it is either a mistake or an attempt to make a
# deploy rewrite a credential; both deserve a hard stop rather than a
# warning somebody scrolls past.
is_secretish() {
  case "$1" in
    *KEY*|*SECRET*|*PASSWORD*|*PASSWD*|*TOKEN*|*CREDENTIAL*|*DATABASE_URL*|*DSN*|*_PW) return 0 ;;
    *) return 1 ;;
  esac
}

# An operator may pin a key on one box: UNMANAGED=AI_MODEL,SOMETHING_ELSE
UNMANAGED_LIST="$(sed -n 's/^UNMANAGED=//p' "$ENV_FILE" | tail -1 | tr -d '"'"'"' ' )"
is_pinned() {
  case ",${UNMANAGED_LIST}," in (*,"$1",*) return 0 ;; (*) return 1 ;; esac
}

changed=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  [ "$key" != "$line" ] || { echo "ERROR: '${line}' is not KEY=VALUE in ${MANAGED_FILE}" >&2; exit 1; }

  case "$key" in
    [A-Z]*) ;;
    *) echo "ERROR: '${key}' is not a valid environment key name" >&2; exit 1 ;;
  esac
  if is_secretish "$key"; then
    echo "ERROR: refusing to manage '${key}' — secrets stay in ${ENV_FILE}, owned by the instance" >&2
    exit 1
  fi
  if is_pinned "$key"; then
    echo "    ${key}: pinned by UNMANAGED in ${ENV_FILE}, left alone"
    continue
  fi

  current="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -1)"
  if [ -n "$current" ] && [ "$current" = "$value" ]; then
    echo "    ${key}: already ${value}"
    continue
  fi

  # Rewritten through a temp file and copied BACK over the original, not
  # moved onto it: a move would replace the inode and with it the 0640
  # root:root the service depends on.
  tmp="$(mktemp)"
  if grep -q "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" \
      'index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } ; next } { print }' \
      "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  echo "    ${key}: ${current:-(unset)} -> ${value}"
  changed=$((changed + 1))
done < "$MANAGED_FILE"

echo "    ${changed} setting(s) changed"
