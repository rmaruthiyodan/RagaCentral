# Backups

A recorded lesson cannot be re-recorded. That single fact sets the priorities:
the media in R2 is irreplaceable, and the database that says whose recording is
whose is what makes the media meaningful. Losing the database turns 10 GB of
audio into 10 GB of anonymous files.

This is a weekly strategy that costs nothing and needs no laptop to be awake.

---

## What can actually go wrong

| | How likely | What saves you |
|---|---|---|
| Teacher deletes a song or student by mistake | Often | Time Travel (below), within 7 days |
| A bad deploy corrupts rows | Occasionally | Time Travel, or last week's export |
| An R2 object is deleted by a bug | Rare | The copy in Backblaze; bucket lock |
| Cloudflare account lost, suspended, or billing lapses | Rare, and total | Only the copies held **outside** Cloudflare |
| The whole D1 database is deleted | Rare, and total | Only the weekly export |

The last two are the reason a backup that lives in the same Cloudflare account
is not a backup. Everything below exists to hold a copy somewhere else.

---

## Layer 0 — Time Travel · already on, nothing to set up

D1 keeps a rolling history and can restore the database to any moment inside
its window. It is on by default and costs nothing. **On the free plan the
window is 7 days**; on the paid plan it is 30.

```bash
npx wrangler d1 time-travel info sruti --remote          # where we are now
npx wrangler d1 time-travel restore sruti \
  --timestamp=2026-09-08T18:00:00Z                       # go back
```

This is the layer to reach for when the teacher says "I deleted Anjali's songs
this morning". It is not a backup: it lives inside the same account, and it
cannot help if the database or the account itself is gone.

---

## Layer 1 — the weekly export · GitHub Actions

`.github/workflows/backup.yml` runs every **Sunday 19:30 UTC (Monday 01:00
IST)** and can be run by hand from the Actions tab before anything risky.

It exports the live database to a `.sql` file, checks that the file is a real
backup rather than an empty one, compresses it, and keeps it as a workflow
artifact for **90 days**. The whole database is a few megabytes, so this stays
well inside the free minutes.

### Setting it up, once

1. In Cloudflare: **My Profile → API Tokens → Create Token → Custom token**.
   Permissions: **Account · D1 · Edit**. Nothing else. Copy the token.
2. In GitHub: the repo's **Settings → Secrets and variables → Actions**:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` — from any Cloudflare dashboard URL
3. Run the workflow once by hand to prove it works.

The workflow **fails loudly** if the export is empty or missing, and GitHub
emails you when a scheduled workflow fails. A silent backup is a backup you
find out about at the worst moment.

> Keep the repository private. The dump contains students' names, email
> addresses and phone numbers.

### Getting a copy onto your own disk

Artifacts expire after 90 days and live inside GitHub. Once a month, download
the newest one from the Actions tab and drop it in whatever you already back
up — Drive, iCloud, an external disk. Two minutes, and it is the only copy that
survives losing both Cloudflare and GitHub.

---

## Layer 2 — the media · copy, don't sync

R2 objects never change once written; the risk is deletion, not corruption.
Two protections, in order of effort:

**Turn on a bucket lock** (five minutes, in the dashboard). R2 → `sruti-media`
→ Settings → Bucket lock. A rule of, say, 90 days means nothing in the bucket
can be deleted or overwritten before then — including by the app itself, or by
anyone with account access.

**Copy the media out weekly.** The second job in the same workflow copies new
objects to a Backblaze B2 bucket (free up to 10 GB, which is roughly 60
students' worth). It is switched off until you add the keys:

1. Backblaze: create a bucket and an application key.
2. Cloudflare: **R2 → Manage R2 API Tokens → Create** with *Object Read* on
   `sruti-media`. This gives an access key id and secret.
3. GitHub secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `B2_KEY_ID`,
   `B2_APP_KEY`, `B2_BUCKET`.
4. GitHub **variable** (not secret) `MEDIA_BACKUP` = `on`.

It runs `rclone copy`, never `rclone sync`. A file deleted in R2 stays in the
backup, which is the entire point.

---

## Getting the backups into Google Drive

Two routes. The first is much less setup and is the one to use unless the Mac
being switched off for a fortnight is a real worry.

### Route A — the Mac writes into your Drive folder · recommended

Google Drive for desktop keeps a **real folder** on the Mac and syncs it. So
"upload to Drive" is just "write a file there": no API keys, no OAuth token to
expire quietly in eighteen months.

**1. Make sure Drive for desktop is installed and signed in.** Check the folder
exists:

```bash
ls ~/Library/CloudStorage/
# GoogleDrive-mailratish@gmail.com
```

**2. Rehearse the script** — this touches nothing live and writes to /tmp:

```bash
cd ~/Documents/sruti
DEST=/tmp/try TARGET=--local ./scripts/backup-to-drive.sh
ls -R /tmp/try
```

**3. Point it at Drive and run it for real.** The default `DEST` is
`~/Library/CloudStorage/GoogleDrive-<your-login>/My Drive/RP Sajeev Music
backups`; if your folder is named differently, set `DEST` to the right path:

```bash
DEST="$HOME/Library/CloudStorage/GoogleDrive-mailratish@gmail.com/My Drive/RP Sajeev Music backups" \
  ./scripts/backup-to-drive.sh
```

Open Drive in a browser. The dump should be there within a minute.

**4. Let it run itself, every Monday at 1am:**

```bash
cp scripts/com.rpsajeev.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.rpsajeev.backup.plist
launchctl start com.rpsajeev.backup          # don't wait for Monday
tail -f ~/Library/Logs/sruti-backup.log
```

Edit the `DEST` line inside `backup-to-drive.sh` if you changed it, since
launchd won't have your shell's environment. If the Mac is asleep at 1am,
launchd runs the job when it next wakes — the week isn't skipped.

**What lands in Drive**

```
RP Sajeev Music backups/
  LAST BACKUP.txt              when, what, and how to restore
  database/
    sruti-2026-09-07.sql.gz    one per week, newest 12 kept
    sruti-2026-09-07.report.json   row counts, checksum
  media/                       only if you set MEDIA_REMOTE
```

**Media too** (optional, needs rclone and R2 keys):

```bash
MEDIA_REMOTE=r2:sruti-media ./scripts/backup-to-drive.sh
```

It runs `rclone copy`, so a recording deleted in R2 stays in Drive. Mind your
Drive quota — 15 GB on a free Google account, shared with Gmail and Photos. If
the library outgrows that, keep the database in Drive and the media in
Backblaze.

**Two things the script refuses to do**, both learned from how these fail:

- If the Drive folder isn't there it stops, rather than writing a "backup" that
  exists only on the Mac.
- If the export comes back empty it stops **before** copying, so this week's bad
  dump never replaces last week's good one. Tested by feeding it an empty dump:
  the existing files were untouched.

### Route B — GitHub Actions uploads to Drive · no Mac needed

Better if the Mac may be off for weeks, and more setup: rclone needs a Google
OAuth token, and it has to be generated on a machine with a browser.

```bash
# once, on the Mac — no Homebrew needed
curl -O https://downloads.rclone.org/rclone-current-osx-arm64.zip
unzip rclone-current-osx-arm64.zip && cd rclone-*-osx-arm64
./rclone config      # n → name it gdrive → drive → blank id/secret →
                     # scope 1 (full) → auto config → sign in
./rclone config show gdrive        # copy the whole token = {...} line
```

Put that token in the repo as the secret `RCLONE_GDRIVE_TOKEN`, then add a step
to `.github/workflows/backup.yml` after the artifact upload:

```yaml
      - name: Copy to Google Drive
        env:
          TOKEN: ${{ secrets.RCLONE_GDRIVE_TOKEN }}
        run: |
          curl -fsSL https://rclone.org/install.sh | sudo bash
          mkdir -p ~/.config/rclone
          printf '[gdrive]\ntype = drive\nscope = drive\ntoken = %s\n' "$TOKEN" \
            > ~/.config/rclone/rclone.conf
          rclone copy backup/ "gdrive:RP Sajeev Music backups/database"
```

A note on why this isn't done with a Google service account, which would be the
tidier way: a service account has no storage quota of its own on a personal
Gmail account, so uploads fail. Service accounts only work here with Google
Workspace and a Shared Drive.

### Whichever route, check it in a month

Open Drive and look at the dates on the files. A backup job that quietly stopped
four weeks ago looks exactly like one that is working, right up until you need
it.

---

## Restoring

### The database

```bash
# 1. Get the newest artifact from the Actions tab and unzip it
gunzip sruti-2026-09-07.sql.gz

# 2. Look at what is in it before trusting it
node scripts/backup-report.mjs sruti-2026-09-07.sql

# 3. Put it back
node scripts/restore.mjs sruti-2026-09-07.sql --remote --wipe
```

`restore.mjs` shows what the database currently holds, makes you type the
database name, drops the old tables, applies the dump, **re-creates the indexes
(they are not in the dump)**, and then compares every table's row count against
the backup. It exits non-zero if anything doesn't match.

Use `--local` to rehearse against the development database first, and
`--dry-run` to see the commands without running them.

### The media

```bash
rclone copy b2:<bucket>/media r2:sruti-media --transfers 8
```

Keys are the R2 object keys, so a restored file lands exactly where the
database expects it. Restoring media without the matching database, or the
other way round, leaves recordings that belong to nobody — restore both from
the same week.

---

## The drill — once a quarter, thirty minutes

A backup is a belief until you have restored from it. Put it in the calendar.

1. Download the newest artifact.
2. `node scripts/backup-report.mjs <dump>` — row counts look like a real week?
3. `node scripts/restore.mjs <dump> --local --wipe` — restores into the
   development database, so nothing live is touched.
4. `npm run dev`, sign in with `/dev/login`, open a student, play a recording.
5. Write the date somewhere. If a drill fails, that is the good outcome — you
   found it on a Tuesday afternoon instead of during a real loss.

This procedure has been run: the drill against a deliberately damaged local
database found that dropping tables in creation order fails on SQLite's foreign
keys. `restore.mjs` now drops in reverse order with `PRAGMA
defer_foreign_keys`. That bug would have surfaced during a real restore.

---

## What this gives you

| | |
|---|---|
| **Worst case data loss** | 7 days (the week between exports) |
| **Recovery time, database** | ~10 minutes, one command |
| **Recovery time, media** | Hours — bounded by download speed, not by effort |
| **Cost** | £0 — free tiers throughout |
| **Copies held outside Cloudflare** | Google Drive (12 weeks), GitHub artifacts (90 days), Backblaze (media) |

If a week ever feels like too much to lose, change the cron in
`backup.yml` to `'30 19 * * *'` and it runs nightly. The export is small; the
limit is your patience, not the free tier.

---

## Why the backup does not run inside the Worker

The obvious design is a Cron Trigger on the Worker itself: dump the tables,
write the file into R2, done. It was rejected for two reasons, both specific to
the free plan:

- **10 ms CPU per invocation.** Serialising a few megabytes of rows to JSON
  costs more than that, and the failure would be intermittent — fine at 20
  students, failing silently at 80.
- **50 subrequests per invocation.** Twelve table reads plus R2 writes and
  paginated listing is close to that ceiling before the library grows.

And a backup written into the same account it protects doesn't answer the
failure that matters most. GitHub Actions has neither limit, holds the copy
somewhere else, and tells you when it breaks.
