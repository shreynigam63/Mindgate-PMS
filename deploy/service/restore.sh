#!/usr/bin/env bash
# Agentic PMS — restore a database backup (native/systemd deployment).
#
#   sudo /opt/agentic-pms/deploy/service/restore.sh /var/backups/agentic-pms/apms-....dump
#
# THIS OVERWRITES THE CURRENT DATABASE. Everything entered since that dump
# is gone. It stops the API first, because restoring under a live app
# means request traffic racing pg_restore's DROPs, which produces errors
# that look like corruption and are really just concurrency.
set -euo pipefail

ENV_FILE=/etc/agentic-pms/api.env
DUMP="${1:-}"
[ -n "$DUMP" ] || { echo "usage: $0 <path-to-.dump>"; exit 1; }
[ -f "$DUMP" ] || { echo "ERROR: no such file: $DUMP" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "ERROR: run with sudo." >&2; exit 1; }

DB_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")"
DB_NAME="${DB_URL##*/}"

echo "About to REPLACE the contents of database '${DB_NAME}' with:"
echo "  ${DUMP}  ($(du -h "$DUMP" | cut -f1), modified $(date -r "$DUMP" -u +%FT%TZ))"
read -r -p "Type the database name to confirm: " CONFIRM
[ "$CONFIRM" = "$DB_NAME" ] || { echo "Aborted."; exit 1; }

systemctl stop agentic-pms-api

# --clean --if-exists drops each object before recreating it, so this works
# against a populated database and not only an empty one.
# --no-owner --no-privileges keeps it working when the role names in the
# dump differ from this box's (a dump taken from Render will).
pg_restore --dbname="$DB_URL" --clean --if-exists --no-owner --no-privileges "$DUMP"

systemctl start agentic-pms-api
echo "Restored. Any migrations the dump predates re-run on the way up:"
echo "  journalctl -u agentic-pms-api -f"
