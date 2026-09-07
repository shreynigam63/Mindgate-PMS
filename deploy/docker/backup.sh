#!/usr/bin/env bash
# Agentic PMS — nightly database backup (Docker deployment).
#
# EBS snapshots are NOT a substitute for this. A snapshot of a running
# Postgres data directory is crash-consistent at best, and it restores as
# a whole volume — you cannot pull one deleted employee out of it. A
# pg_dump is a consistent logical copy you can restore selectively, on a
# different Postgres version, on a different machine.
#
# Install as a cron job (see deploy/README.md):
#   15 2 * * *  /opt/agentic-pms/deploy/docker/backup.sh >> /var/log/apms-backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")"

[ -f .env ] || { echo "ERROR: no .env in $(pwd) — nothing to back up from." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env; set +a

KEEP_DAYS="${KEEP_DAYS:-14}"
DB_USER="${POSTGRES_USER:-apms}"
DB_NAME="${POSTGRES_DB:-apms}"

if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "ERROR: neither 'docker compose' nor 'docker-compose' is installed." >&2; exit 1; fi

mkdir -p backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="apms-${STAMP}.dump"

# -Fc (custom format) rather than plain SQL: it is compressed, and
# pg_restore can list and selectively restore from it.
#
# Written to /backups INSIDE the container, which is bind-mounted to
# ./backups on the host — deliberately not piped to stdout, because a
# shell redirection creates the output file before pg_dump runs and
# leaves a zero-byte "backup" behind if the dump then fails.
$DC exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "/backups/${NAME}"

# A backup nobody has read is a guess. pg_restore -l fails loudly on a
# truncated or corrupt archive, so this turns "the file exists" into "the
# file is a readable dump" for the price of a fraction of a second.
if ! pg_restore -l "backups/${NAME}" >/dev/null 2>&1; then
  if ! $DC exec -T db pg_restore -l "/backups/${NAME}" >/dev/null 2>&1; then
    echo "ERROR: ${NAME} is not a readable dump — leaving it in place for inspection." >&2
    exit 1
  fi
fi

SIZE="$(du -h "backups/${NAME}" | cut -f1)"
echo "$(date -u +%FT%TZ) backup ok: backups/${NAME} (${SIZE})"

# Prune AFTER a verified new backup, never before — so a failing backup
# job cannot quietly eat the history it was supposed to be adding to.
find backups -name 'apms-*.dump' -type f -mtime "+${KEEP_DAYS}" -print -delete

echo "$(date -u +%FT%TZ) retention: kept $(find backups -name 'apms-*.dump' | wc -l) dump(s), ${KEEP_DAYS}-day window"
echo "REMINDER: these live on the same EBS volume as the database. Copy them off the box (S3) for them to count as a backup."
