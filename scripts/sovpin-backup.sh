#!/usr/bin/env bash
# SovPin encrypted SQLite backup.
# - Online-safe snapshot via the Python sqlite3 backup API (never raw-cp the WAL).
# - gzip + age encryption; snapshots stay local, newest 7 kept.
# - Off-host copy to the MacBook when SSH is reachable; otherwise the remote
#   leg is skipped with a warning (exit stays 0 so the timer keeps the local
#   chain intact). Re-enable by restoring ~/.ssh/macbook_sovpin access.
# Usage: scripts/sovpin-backup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${SOVPIN_DB_PATH:-$REPO_DIR/dashboard/data/sovpin.sqlite}"
LOCAL_DIR="${SOVPIN_BACKUP_DIR:-$HOME/.local/share/sovpin/backups}"
RECIPIENT_FILE="${SOVPIN_BACKUP_RECIPIENT:-$HOME/.config/sovpin/backup.recipient}"
REMOTE="${SOVPIN_BACKUP_REMOTE:-macbook@192.168.86.110:~/sovpin-backups}"
SSH_KEY="${SOVPIN_BACKUP_SSH_KEY:-$HOME/.ssh/macbook_sovpin}"
KEEP=7

mkdir -p "$LOCAL_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SNAP="$LOCAL_DIR/.sovpin-$STAMP.sqlite"
OUT="$LOCAL_DIR/sovpin-$STAMP.sqlite.gz.age"

python3 - "$DB_PATH" "$SNAP" <<'EOF'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(f'file:{src}?mode=ro', uri=True)
d = sqlite3.connect(dst)
with d:
    s.backup(d)
res = d.execute('PRAGMA integrity_check').fetchall()
if res != [('ok',)]:
    raise RuntimeError(f'SQLite integrity check failed on backup snapshot: {res}')
s.close(); d.close()
EOF

if [ ! -f "$RECIPIENT_FILE" ]; then
  echo "Backup recipient not found: $RECIPIENT_FILE (set SOVPIN_BACKUP_RECIPIENT)" >&2
  rm -f "$SNAP"
  exit 2
fi
gzip -c "$SNAP" | age -r "$(cat "$RECIPIENT_FILE")" -o "$OUT"
chmod 600 "$OUT"
rm -f "$SNAP"

# Retention (local).
ls -t "$LOCAL_DIR"/sovpin-*.sqlite.gz.age 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

# Off-host leg (best effort).
if ssh -o BatchMode=yes -o ConnectTimeout=8 -i "$SSH_KEY" "${REMOTE%%:*}" "mkdir -p ${REMOTE#*:}" 2>/dev/null; then
  scp -o BatchMode=yes -o ConnectTimeout=15 -i "$SSH_KEY" "$OUT" "$REMOTE/" \
    && ssh -o BatchMode=yes -i "$SSH_KEY" "${REMOTE%%:*}" \
      "ls -t ${REMOTE#*:}/sovpin-*.sqlite.gz.age 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f"
  echo "backup ok (local + remote): $OUT"
else
  echo "backup ok (local only): $OUT — remote unreachable, parked until SSH is restored" >&2
fi
