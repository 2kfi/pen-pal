#!/usr/bin/env bash
#
# Take a backup of the PenPal database.
#
#   ./scripts/backup.sh
#   ./scripts/backup.sh --no-uploads          # skip plaintext photo blobs
#   BACKUP_DIR=/mnt/nas ./scripts/backup.sh   # write somewhere else
#
# Safe to run while the server is up.
#
# WHY NOT `cp penpal.db backups/`:
#
#   The database runs in WAL mode. Recent writes live in `penpal.db-wal` and are
#   only folded back into the main file at a checkpoint. Copying `penpal.db`
#   alone therefore produces a file that is missing its own tail — the most
#   recent letters simply are not in it. Depending on timing you get either a
#   silently stale backup or a corrupt one, and there is no way to tell which
#   from the copy itself.
#
#   This script uses SQLite's online backup API (the same machinery as the
#   `sqlite3` shell's `.backup`), which takes a read lock per page and writes
#   one self-consistent file with the WAL included. It also runs an
#   `integrity_check` on the result and refuses to report success without one.
#
# Retention: BACKUP_RETENTION backups are kept (default 14, 0 keeps everything).
# Older ones are pruned by timestamp. Set it to something you have tested.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not on PATH" >&2
  exit 1
fi

# Keep dotenv's DATA_DIR visible if there is a .env, matching how the server
# finds the database. A missing .env is normal and not an error.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

exec node "$ROOT/scripts/ops-db.js" backup "$@"