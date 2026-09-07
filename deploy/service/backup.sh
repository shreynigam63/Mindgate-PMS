#!/usr/bin/env bash
# Agentic PMS — nightly database backup (native/systemd deployment).
# Run by agentic-pms-backup.timer at 02:15 local. Also safe to run by hand.
#
# EBS snapshots are NOT a substitute. A snapshot of a live Postgres data
# directory is crash-consistent at best and restores as a whole volume —
# you cannot pull one deleted employee out of it. A pg_dump is a
# consistent logical copy, restorable selectively, on another machine or
# another Postgres version.
set -euo pipefail

ENV_FILE=/etc/agentic-pms/api.env
BACKUP_DIR="${BACKUP_DIR:-/var/backups/agentic-pms}"
KEEP_DAYS="${KEEP_DAYS:-14}"

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found — is this host installed?" >&2; exit 1; }

# The connection string is already in the service's env file, so there is
# no second copy of the credentials to keep in step (or to leak).
DB_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")"
[ -n "$DB_URL" ] || { echo "ERROR: no DATABASE_URL in $ENV_FILE" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/apms-${STAMP}.dump"

# -Fc (custom format): compressed, and pg_restore can list and selectively
# restore from it. Written directly to $OUT rather than piped, so a failed
# dump does not leave a zero-byte file that looks like a backup.
pg_dump --dbname="$DB_URL" -Fc -f "$OUT"
chmod 600 "$OUT"

# A backup nobody has read is a guess. pg_restore -l fails loudly on a
# truncated or corrupt archive.
pg_restore -l "$OUT" >/dev/null || {
  echo "ERROR: ${OUT} is not a readable archive — keeping it for inspection." >&2; exit 1; }

echo "$(date -u +%FT%TZ) backup ok: ${OUT} ($(du -h "$OUT" | cut -f1))"

# Prune only AFTER a verified new backup, so a failing job cannot quietly
# eat the history it was supposed to be adding to.
find "$BACKUP_DIR" -name 'apms-*.dump' -type f -mtime "+${KEEP_DAYS}" -print -delete
echo "$(date -u +%FT%TZ) retention: $(find "$BACKUP_DIR" -name 'apms-*.dump' | wc -l) dump(s) kept, ${KEEP_DAYS}-day window"

# OFF-BOX COPY. Uncomment and set a bucket to make these survive the
# instance. Until this is on, a lost EBS volume is a lost database — the
# dumps are on the same disk as the thing they are backing up.
# aws s3 sync "$BACKUP_DIR" "s3://YOUR-BUCKET/agentic-pms/$(hostname)/" --only-show-errors
