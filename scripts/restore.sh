#!/usr/bin/env bash
#
# Restore the PenPal database from a backup directory.
#
#   ./scripts/restore.sh                                   # prints the plan, changes nothing
#   ./scripts/restore.sh penpal-2026-10-14T10-17-58Z --yes # actually do it
#
# STOP THE SERVER FIRST. Always.
#
#   docker compose stop pen-pal
#   ./scripts/restore.sh penpal-2026-10-14T10-17-58Z --yes
#   docker compose start pen-pal
#   curl -fsS localhost:3000/healthz        # must report ok:true
#
# Without `--yes` this script changes nothing and exits 2. That is intentional:
# a restore is not something that should happen because somebody pasted a
# command without reading it.
#
# What it does, in order:
#   1. refuses unless --yes
#   2. runs integrity_check on the backup and refuses if it fails
#   3. refuses a v0.0.2-shaped backup unless --allow-old-shape (restoring that
#      into the current app returns you to the permanently-broken state the
#      migration runner exists to fix)
#   4. copies the CURRENT database aside to penpal.db.pre-restore-<timestamp>
#      so the restore is itself reversible
#   5. copies the backup in via a temp file + rename, so an interruption leaves
#      the old database intact
#   6. deletes any stale -wal / -shm, which belong to the database that was
#      just replaced and would be replayed over the restored file otherwise
#
# See docs/MIGRATION.md for the full upgrade and rollback procedure.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not on PATH" >&2
  exit 1
fi

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

exec node "$ROOT/scripts/ops-db.js" restore "$@"