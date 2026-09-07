#!/usr/bin/env bash
# Agentic PMS — restore a database backup (Docker deployment).
#
#   ./restore.sh backups/apms-20260907T021500Z.dump
#
# THIS OVERWRITES THE CURRENT DATABASE. It drops and recreates every
# object the dump contains, so anything entered since that dump is gone.
set -euo pipefail

cd "$(dirname "$0")"
DUMP="${1:-}"
[ -n "$DUMP" ] || { echo "usage: $0 <path-to-.dump>"; exit 1; }
[ -f "$DUMP" ] || { echo "ERROR: no such file: $DUMP" >&2; exit 1; }

# shellcheck disable=SC1091
set -a; . ./.env; set +a
DB_USER="${POSTGRES_USER:-apms}"
DB_NAME="${POSTGRES_DB:-apms}"

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

echo "About to REPLACE the contents of database '${DB_NAME}' with:"
echo "  ${DUMP}  ($(du -h "$DUMP" | cut -f1), modified $(date -r "$DUMP" -u +%FT%TZ))"
read -r -p "Type the database name to confirm: " CONFIRM
[ "$CONFIRM" = "$DB_NAME" ] || { echo "Aborted."; exit 1; }

# Stop the API first. Restoring under a live app means migrations and
# request traffic racing pg_restore's DROPs, which produces failures that
# look like corruption and are really just concurrency.
$DC stop api web

# --clean --if-exists drops each object before recreating it, so this
# works against a populated database, not just an empty one.
# --no-owner --no-privileges keeps it working when the role names in the
# dump differ from the ones on this box (a dump taken from Render will).
$DC exec -T db pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --clean --if-exists --no-owner --no-privileges < "$DUMP"

$DC start api web
echo "Restored. The API will re-run any migrations the dump predates on the way up."
echo "Watch it come up:  $DC logs -f api"
