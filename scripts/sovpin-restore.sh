#!/usr/bin/env bash
# SovPin encrypted SQLite restore (companion to sovpin-backup.sh).
# Usage: scripts/sovpin-restore.sh <backup-file.sqlite.gz.age> [--force]
# - Decrypts with age, gunzips, runs PRAGMA integrity_check.
# - Refuses to overwrite a live DB unless --force is given and the service is stopped.
set -euo pipefail

BACKUP="${1:-}"
FORCE="${2:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${SOVPIN_DB_PATH:-$REPO_DIR/dashboard/data/sovpin.sqlite}"
IDENTITY="${SOVPIN_BACKUP_IDENTITY:-$HOME/.config/sovpin/backup.key}"

if [ -z "$BACKUP" ]; then
  echo "Usage: $0 <backup-file.sqlite.gz.age> [--force]" >&2
  exit 2
fi
if [ ! -f "$BACKUP" ]; then
  echo "Backup file not found: $BACKUP" >&2
  exit 2
fi
if [ -z "${IDENTITY:-}" ] || [ ! -f "$IDENTITY" ]; then
  echo "Age identity not found: $IDENTITY (set SOVPIN_BACKUP_IDENTITY)" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SNAP="$TMP/restore.sqlite"

age -d -i "$IDENTITY" -o "$TMP/restore.sqlite.gz" "$BACKUP"
gzip -dc "$TMP/restore.sqlite.gz" > "$SNAP"

python3 - "$SNAP" <<'EOF'
import sqlite3, sys
d = sqlite3.connect(sys.argv[1])
res = d.execute('PRAGMA integrity_check').fetchall()
if res != [('ok',)]:
    raise SystemExit(f'SQLite integrity check failed on restore candidate: {res}')
tables = {r[0] for r in d.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
for required in ('tenants', 'pins', 'invoices', 'sessions'):
    if required not in tables:
        raise SystemExit(f'Restore candidate missing required table: {required}')
print('restore candidate ok: integrity_check passed')
EOF

if [ -f "$DB_PATH" ] && [ "$FORCE" != "--force" ]; then
  echo "Refusing to overwrite live DB without --force: $DB_PATH" >&2
  echo "Stop the service first, then re-run with --force." >&2
  exit 2
fi

mkdir -p "$(dirname "$DB_PATH")"
if [ -f "$DB_PATH" ]; then
  cp -a "$DB_PATH" "$DB_PATH.pre-restore-$(date -u +%Y%m%d-%H%M%S).bak"
fi
cp -a "$SNAP" "$DB_PATH"
echo "restore ok: $BACKUP -> $DB_PATH"
