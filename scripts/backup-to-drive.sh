#!/bin/bash
# ===================================================================
# Weekly backup into a Google Drive folder.
#
# Google Drive for desktop keeps a real folder on the Mac and syncs it,
# so "upload to Drive" is just "write a file there". No API keys, no
# OAuth tokens to expire — which is why this is the version that keeps
# working a year later.
#
#   ./scripts/backup-to-drive.sh                 # the real thing
#   DEST=/tmp/try TARGET=--local ./scripts/...   # a rehearsal
#
# Run it by hand once. Then let launchd run it weekly — see BACKUP.md.
# ===================================================================
set -euo pipefail

# --- settings ------------------------------------------------------
DB="${DB:-sruti}"
TARGET="${TARGET:---remote}"          # --remote is the live database
KEEP="${KEEP:-12}"                    # weeks of dumps to keep
DEST="${DEST:-$HOME/Library/CloudStorage/GoogleDrive-$(id -un)/My Drive/RP Sajeev Music backups}"
MEDIA_REMOTE="${MEDIA_REMOTE:-}"      # e.g. r2:sruti-media — needs rclone
PROJECT="${PROJECT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Cloudflare credentials, if you'd rather not rely on `wrangler login`.
# ~/.sruti-backup.env is a plain file holding CLOUDFLARE_API_TOKEN=...
# Keep it chmod 600; it is never committed.
[ -f "$HOME/.sruti-backup.env" ] && . "$HOME/.sruti-backup.env"

stamp="$(date -u +%Y-%m-%d)"
log() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

cd "$PROJECT"

log "backup $stamp → $DEST"

# --- 1. is Drive actually there? -----------------------------------
# Writing into a folder that Drive isn't syncing produces a backup that
# exists only on this Mac — the exact failure this whole thing exists to
# avoid. So check, and refuse rather than pretend.
if [ ! -d "$DEST" ]; then
  parent="$(dirname "$DEST")"
  [ -d "$parent" ] || die "No such folder: $parent
   Is Google Drive for desktop installed and signed in?
   Look under ~/Library/CloudStorage/ for the exact name and set DEST."
  mkdir -p "$DEST"
  log "created $DEST"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- 2. export the database ----------------------------------------
dump="$tmp/$DB-$stamp.sql"
log "exporting the database"
npx --yes wrangler@4 d1 export "$DB" "$TARGET" --output "$dump" >/dev/null \
  || die "wrangler could not export the database"

# --- 3. is it a real backup? ---------------------------------------
# An empty dump is the failure that looks like success. backup-report
# exits non-zero when the users table is empty, which stops us here
# rather than overwriting last week's good copy with this week's bad one.
log "checking what was captured"
node scripts/backup-report.mjs "$dump" || die "that dump does not look like a real backup — keeping the old ones"

# The report has to be taken from the SQL, before it is compressed —
# reading a .gz as text reports a perfectly healthy zero rows.
node scripts/backup-report.mjs "$dump" --json > "$tmp/report.json"

# --- 4. put it in Drive --------------------------------------------
gzip -9 "$dump"
mkdir -p "$DEST/database"
cp "$dump.gz" "$DEST/database/"
cp "$tmp/report.json" "$DEST/database/$DB-$stamp.report.json"
log "wrote $(basename "$dump.gz") ($(du -h "$dump.gz" | cut -f1))"

# --- 5. keep the last N ---------------------------------------------
# Deleting the oldest by name works because the name is a date.
count=$(ls -1 "$DEST/database"/*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -gt "$KEEP" ]; then
  ls -1 "$DEST/database"/*.sql.gz | sort | head -n "$((count - KEEP))" | while read -r old; do
    log "pruning $(basename "$old")"
    rm -f "$old" "${old%.sql.gz}.report.json"
  done
fi

# --- 6. media, if rclone is set up ----------------------------------
# copy, never sync: a recording deleted in R2 must stay in the backup.
if [ -n "$MEDIA_REMOTE" ]; then
  command -v rclone >/dev/null || die "MEDIA_REMOTE is set but rclone isn't installed"
  log "copying new media from $MEDIA_REMOTE"
  rclone copy "$MEDIA_REMOTE" "$DEST/media" --transfers 4 --stats 30s --stats-one-line
  log "media now: $(rclone size "$DEST/media" --json 2>/dev/null | sed 's/.*"bytes":\([0-9]*\).*/\1/' | awk '{printf "%.1f GB", $1/1073741824}')"
fi

# --- 7. leave a note a human can read -------------------------------
{
  echo "Last backup: $(date '+%A %d %B %Y, %H:%M %Z')"
  echo "Database:    $(basename "$dump.gz")"
  echo "Kept:        $(ls -1 "$DEST/database"/*.sql.gz 2>/dev/null | wc -l | tr -d ' ') weekly dumps"
  [ -n "$MEDIA_REMOTE" ] && echo "Media:       copied from $MEDIA_REMOTE"
  echo
  echo "To restore:  node scripts/restore.mjs <dump.sql> --remote --wipe"
  echo "See BACKUP.md in the project for the full procedure."
} > "$DEST/LAST BACKUP.txt"

log "done"
