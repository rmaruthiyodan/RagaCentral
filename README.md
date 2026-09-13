# RP Sajeev Music

A private recording library for a Carnatic vocal teacher and his students.
("Sruti" is the codebase's own name; the site the teacher and students see is
**RP Sajeev Music**, set by `SITE_NAME` in `wrangler.toml`.)

The teacher records or uploads audio and short video for each student, files them under a song,
and adds notes. Students sign in with Google and see only what has been assigned to them, with
slow playback that doesn't change pitch and an A–B loop for the phrase they're working on.

Runs entirely on Cloudflare's free tier: Workers for the app, D1 for the data, R2 for the media.
Downloads from R2 are free at any volume, which is what keeps this at $0 a month.

---

## What's here

```
src/
  index.ts          every route
  auth.ts           Google sign-in, signed session cookies, route guards
  types.ts          shared types
  util.ts           ids, formatting, MIME helpers
  views/
    layout.ts       page shell
    pages.ts        every screen
    sessions.ts     the lesson log — resume card, history, log form
    schedule.ts     upcoming classes, week calendar, day view, weekly slots
    student.ts      one student, split into five tabs
    klass.ts        one class, opened to teach it
    song.ts         the song page — recordings by part, notes, who's learning it
  catalogue-seed.ts the starter repertoire loaded from the Songs page
  tz.ts             the time-zone engine (see below)
public/
  app.css           the whole design system, no framework
  player.js         speed control and A–B loop
  recorder.js       browser recording, MP3 encoding, uploads
  disclose.js       remembers which collapsible sections you left open
  vendor/           lame.min.js — the MP3 encoder, loaded only on the record screen
schema.sql          the tables
indexes.sql         the indexes — applied after the columns, see below
backfill.sql        data fixups, safe to run again
scripts/
  sync-schema.mjs   adds columns an existing database is missing
  backup-report.mjs what a .sql dump actually contains
  restore.mjs       put a dump back, then verify it row by row
  backup.mjs        the weekly backup — database and recordings → Google Drive
  restore-media.mjs put the recordings back into R2 from that backup
  lib/r2.mjs        a small signed-HTTPS client for R2
  lib/media-keys.mjs which files the database expects to exist
  com.rpsajeev.backup.plist  the launchd job that runs the backup
  media-audit.mjs   every recording still has its file?
.github/workflows/
  deploy.yml        push to main → checks → schema → deploy → healthz
  backup.yml        the weekly export — see BACKUP.md
migrations/         the same changes as hand-written SQL, if you prefer
wrangler.toml       Cloudflare configuration
```

---

## Setting it up

You need a Cloudflare account and a Google Cloud project. Both are free; Cloudflare will ask
for a card when you switch R2 on, even though nothing here costs anything.

### 1. Install and log in

```bash
npm install
npx wrangler login
```

### 2. Create the database and the bucket

```bash
npx wrangler d1 create sruti
npx wrangler r2 bucket create sruti-media
```

The first command prints a `database_id`. Paste it into `wrangler.toml`, replacing
`PUT_YOUR_D1_DATABASE_ID_HERE`.

Then set up the database. Four steps, and the order matters:

```bash
npx wrangler d1 execute sruti --remote --file=./schema.sql    # 1. tables
node scripts/sync-schema.mjs --remote                         # 2. any missing columns
npx wrangler d1 execute sruti --remote --file=./indexes.sql   # 3. indexes
npx wrangler d1 execute sruti --remote --file=./backfill.sql  # 4. data fixups
```

**The same four commands upgrade an existing database.** They are safe to re-run any number of
times: steps 1–3 never drop or alter anything, and every statement in step 4 is written so a
second run matches nothing.

### 3. Set up Google sign-in

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project (any name).
2. **APIs & Services → OAuth consent screen** — choose **External**, fill in the app name and
   your email. You do not need to publish it or get it verified; while it is in "Testing" you
   add each student's Google address under **Test users**. If you'd rather not maintain that
   list, publish the app — a sign-in-only app that requests just name and email does not need
   Google's review.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized redirect URIs** add:

   ```
   https://sruti.<your-subdomain>.workers.dev/auth/callback
   ```

   (After the first deploy, Wrangler prints your exact address. Add the real one, and add
   `http://localhost:8787/auth/callback` too if you want to test locally.)
4. Copy the client ID and client secret.

### 4. Set the secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET     # any long random string
```

For `SESSION_SECRET`, something like `openssl rand -base64 32` is ideal. Changing it later
signs everyone out, which is the quickest way to revoke every session at once.

### 5. The site's name and logo

`SITE_NAME` in `wrangler.toml` is the name in the top bar and every page title — it is
**RP Sajeev Music**. The mark beside it is `public/logo.png` (96px, drawn at 30) and the browser
tab icon is `public/favicon.png` (64px). To change either, drop in a square image at those two
sizes; nothing else needs touching.

### 6. Name the first teacher

In `wrangler.toml`, set `BOOTSTRAP_TEACHER_EMAIL` to the Google address that should become the
first teacher. The first time that address signs in, it gets the teacher role automatically.
Everybody else who signs in waits for approval.

This only applies while there are no teachers yet, so leaving it in place is harmless.

### 7. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the address. Open it, sign in as the teacher, and go.

---

## Day-to-day

**Adding a student.** Two ways. Either the student signs in with Google and the teacher approves
them under **Approvals**, or the teacher adds their Google address in advance under
"Invite someone by email" — then they're in as soon as they sign in, with no second step.

Each student can also carry where they are, their time zone, and a **WhatsApp number**. Give it
with the country code and it becomes a link — one tap from their page, or from the class screen
mid-lesson, opens the chat. The number is searchable along with name, email and place.

**Adding a song.** Under **Songs**. Groups are whatever the teacher wants them to be — stages,
ragas, a concert set. Songs carry an optional Malayalam title alongside the transliteration;
both are searchable and both are shown.

An empty catalogue offers **Load starter catalogue**: 91 songs in 10 groups — sarali, janta,
dhatu and sthayi varisai, alankarams, geethams, swarajatis, and the Adi and Ata tala varnams,
with raga, taala and composer filled in. It only adds what's missing, so pressing it twice
changes nothing and your own edits are never overwritten.

**The song page.** Opening a song from the catalogue gives you everything about it in one place:
its details, its recordings grouped by which part of the song they cover, its notes, who is
learning it now, and who has finished it.

**Everything long folds up.** Groups on the Songs page, each part of a song, and each recording
are collapsible sections. A closed recording still shows its name, its part, who can hear it, its
length and its description — enough to pick the right one without opening it. The first take in
each part is open so there's always something to press play on, and **Expand all / Collapse all**
is above the list. Your browser remembers what you left open; nothing about that is sent to the
server, and it all works with JavaScript off, just without the memory.

**Opening a student.** A student's page is five tabs, so you're never scrolling past things you
didn't come for: **Overview** (where you stopped last time, the next class, what they're learning
now, the last few lessons), **Songs**, **Past classes**, **Schedule** and **Settings**. Each tab
carries a count, so you can see there are 12 songs and 30 lessons without opening either.

**Assigning.** Open a student's **Songs** tab, pick from the catalogue. The same song can sit with
different students at different stages, because recordings belong to a student *and* a song.

**Recording.** Open a song and hit record. Audio is captured, then converted to MP3 in the
browser before it uploads. Video is capped at two minutes. Tag a take with the part it covers —
pallavi, anupallavi, charanam — and the song page groups them for you.

**Naming a take.** Every recording has a name — it's required when you record, and an upload is
named after its file if you don't give it one. Rename any of them later under *Edit this
recording*.

**Describing a take.** Every recording takes a line or two of description — "anupallavi at half
speed", "the second sangati, listen for the gamaka" — shown under its title wherever it's played.
Notes take a heading of their own for the same reason. Both are optional and both are editable
later.

**Who hears what.** Recordings and notes belong to the *song* and go to everyone learning it by
default, so a reference recording made once serves every student. **Who can hear it** on any
recording — and **Who can see it** on any note — switches it to a named set of students instead:
tick as many as you like, so the same correction can go to three people without being copied
three times. The pill on each item says where it stands: *everyone*, a name, or *3 students*.
Ticking nobody leaves it with everyone, because a recording no one can hear is never what was
meant. You can also choose the audience *before* recording or uploading, under **Add a
recording** — it applies to whatever you add next.

**Locked recordings.** A student's song page lists *every* recording on that song. The ones
shared with them play; the rest appear under **Not yet shared with you** — name, part and
description visible, nothing to play, and the file itself refused if the address is guessed. So a
student can see what exists and ask for it, instead of not knowing. Opening the same page as the
teacher (from their Songs tab) shows the same list with **Unlock for <name>** on each locked one
and **Lock** on each shared one, so handing a take over is one click from where the question came
up. Locking a recording that was for everyone keeps it with everyone else — the others are
written in explicitly, nobody loses anything silently.

**Notes.** Two kinds, kept apart. A note about one take lives inside that recording, under
**Notes on this recording**; a note about the song sits in **Notes about the whole song** at the
bottom. Both are typed, take an optional heading and screenshot (you can paste an image straight
in), can be reordered with the arrows, edited, and given their own audience.

**Saving a note.** Every note offers **Download note** — a text file with its heading, body, the
song it belongs to and the date — and, when it has a screenshot, **Download image**. Both are
subject to the same audience rules as the note itself.

**Searching.** There's a search box on Students (name, email, place), on Songs (title in either
script, raga, taala, composer) and on a student's own list.

**Reordering.** Arrows on each recording and note move it up or down, so the order a student
sees is the order you want them practised in. Each moves **within its own group**: a recording
among the other takes of the same part, a note among the notes on its recording or among the
song-wide ones. Open a recording and the arrows are in its controls row, beside Download.

**Editing a song.** "Edit song details" on the song page changes its title, Malayalam title,
raga, taala, composer or group without touching its recordings.

**Students who stop.** Each student is active, paused, graduated or ended, set from their own
page with an optional note ("back after exams in June"). Only active students are listed by
default; a checkbox brings the rest back.

**Anyone not active has nothing ahead of them in the schedule** — no upcoming classes in the
week, the day view or the list — but **every class they already had stays where it was**, marked
with their status, so looking back at March still shows who you were teaching in March. Their
weekly slots are kept, and their Schedule tab says why nothing is listed. Make them active again
and the future comes back. **Nothing is ever deleted** — recordings, lesson history and schedule
all stay.

**Marking a song finished.** On a student's page, "Mark finished" moves a song out of *Learning
now* into *Finished*. Nothing is deleted — the recordings stay available for practice, and
"Reopen" puts it back.

**Logging a lesson.** Easiest from the class screen (below), where the date and length are already
filled in. Otherwise open the student's **Past classes** tab and use the form there: date, which
songs you worked on, what you covered, and — the field that matters — **where you stopped**. Mark
it *finished* or *still in the middle of it*.

The most recent lesson's stopping point is pinned to the top of that student's page, so the first
thing you see when you open them next week is where to carry on from. A lesson left as *ongoing*
shows in brass with a "Mark this lesson finished" button; a finished one shows quietly as "Last
lesson". Under **Lessons** there's a running count — total, completed, ongoing — and the full
history, each entry editable.

Students see all of this, including the "to practise before next time" line, which appears at the
top of their own page.

---

## Speaking a lesson note in Malayalam

The teacher writes up his classes on an iPhone, and Apple's dictation has no
Malayalam — only English (India) and Hindi among Indian languages. Safari's
in-browser speech recognition borrows the same list. So the app does not ask the
phone to know Malayalam: it records the clip, sends it up, and transcribes it
server-side.

Each of the three lesson fields — what you covered, where you stopped, what to
practise — has a **Speak it** button. Say a sentence, press it again, and the
Malayalam and an English rendering both land in the form. **Nothing is saved
until you press Save**, so a transcript that gets a word wrong costs a retry and
nothing else. Speaking twice appends rather than replaces, and anything you have
already typed survives.

Both languages are stored: `covered_ml` beside `covered`, and so on, the way a
song keeps `title_ml` beside `title`. Wherever a lesson is read back — the
resume card, the history, the class screen, the student's own page — his
Malayalam leads and the English sits under it, so a student abroad who doesn't
read the script still follows.

### Which engine

| | |
|---|---|
| `workers-ai` (default) | Whisper inside Cloudflare. **Free at this volume** — 10,000 neurons a day and Whisper costs 46.63 per audio minute, so around 200 minutes daily at no charge. Needs no account beyond the one already running the app. Whisper is a general multilingual model and is much weaker on Indic languages than European ones. |
| `sarvam` | Built for Indian languages. About ₹0.50 a minute, with free credits to start. Worth paying for because of `keyterms`: the app hands it the Carnatic vocabulary **and this teacher's own song titles and ragas**, so *gamaka* and *Vatapi Ganapatim* come back as themselves. Its `codemix` mode is also the right shape for Malayalam with English terms left in. |

Set `DICTATE_PROVIDER` in wrangler.toml. For Sarvam, also
`npx wrangler secret put SARVAM_API_KEY`. `DICTATE = "off"` hides the microphone
entirely.

Start on `workers-ai`, since it costs nothing, and listen to what comes back. If
the Carnatic words are mangled, switch — it is one line, not a rewrite.

**If nothing is configured the button simply doesn't appear**, and every form
still works exactly as it did. The feature is additive from top to bottom.

## The schedule

**Setting it up.** Schedule → Manage weekly slots. Each student can have as many slots as they
need — two one-hour classes a week is the normal case. Times are always entered in **Indian
time**. Each student's time zone is picked from a dropdown of the zones students actually live
in — when you add them, or later under their **Settings** tab. It's also filled in automatically
the first time they open the site, but only if you haven't set it yourself.

**Reading it.** Signing in as the teacher lands on the week, because that's the question you
actually have. Seven days, each class a chip with the student's name, showing your time and
theirs underneath; today's classes are lifted out into a strip at the top. Click a day to open
it. There's also a list view covering the next 7, 14 or 30 days. When a class falls on a
different day for the student — common for Australia and the Americas — it's flagged, because
that's the mistake that actually makes someone miss a lesson.

**Teaching one.** **Start class** on any occurrence opens that single class: both clocks, then
where you stopped last time and what they were asked to practise, then the songs to work on as
links straight into their recordings, then the log form with the date and length prefilled — and,
at the bottom, the buttons for the class that isn't going to happen. It's the one screen to have
open while teaching.

**Changing one class.** From a day, or from "Change" in the list view, you can:

- **Cancel it** — a planned no-class, with a reason. Shown struck through.
- **Mark it missed** — it should have happened and didn't. A different fact from a cancellation,
  so it looks different and is never hidden.
- **Reschedule it** — move that one class to another date and time in Indian time; the student's
  own time is recalculated.

The weekly rule stays intact in every case, and "Put it back" undoes any of them.

**On a student's page** the **Schedule** tab has their slots and their next few classes. **Past
classes** has a month calendar of their history — held, missed, cancelled and upcoming, each in
its own colour — and every day with a class is clickable: a day you've written up jumps to that
lesson below, an upcoming one opens the class screen. That, plus the tabs, is the answer to
"which Tuesday was it that we did the charanam?".

Students see their own next classes on their page, in their own time.

---

## Why the schema is split into three files

`CREATE TABLE IF NOT EXISTS` does **nothing** to a table that already exists. So when a new
version of `schema.sql` adds a column, an upgraded database never receives it — and any index or
query over that column then fails with `no such column`, which takes the whole app down at
startup.

So the schema is applied in four ordered steps instead:

1. **`schema.sql`** — `CREATE TABLE IF NOT EXISTS` only. Creates whatever is missing.
2. **`scripts/sync-schema.mjs`** — reads the column list out of `schema.sql`, asks the live
   database what it actually has, and issues `ALTER TABLE ADD COLUMN` for the difference. It is
   driven entirely by `schema.sql`, so it stays correct as the schema grows and nobody has to
   remember to hand-write a migration. It only ever adds; it never alters or drops.
3. **`indexes.sql`** — every index, created after step 2, once the columns are guaranteed to exist.
4. **`backfill.sql`** — the rows themselves, when what they mean has changed. Structure isn't
   always enough: turning "private to one student" into "shared with these students" meant moving
   data, not just adding a table. Each statement is written so that its own effect removes the
   rows it selects, which is what makes a second run a no-op.

The container runs all four on every start, so upgrading is just `docker compose up --build`.

`migrations/` holds the same changes as hand-written SQL. You don't need them if you use the
three steps above; they're there if you'd rather apply a specific change deliberately.

---

## Why the time-zone code looks the way it does

Every class is anchored to a wall time in India, and India has never observed daylight saving.
That makes IST a fixed UTC+05:30, so turning "Tuesday 7pm IST" into a real instant is plain
arithmetic — no library, no table of rules that goes out of date.

The students are the ones who move. Their side is computed per occurrence with `Intl`, which
knows each zone's daylight-saving rules, so the same 7pm IST class correctly shows as 9:30am in
New York for part of the year and 8:30am for the rest.

The trap this avoids is storing a numeric offset per student. An offset is wrong for about half
the year in any country that changes its clocks. `users.time_zone` holds an IANA name
(`America/New_York`), never `-5`.

`test-tz.mjs` checks this against real transitions in New York, London and Sydney:

```bash
node --experimental-strip-types test-tz.mjs
```

Occurrences are computed on read rather than stored as rows. Editing a slot corrects every future
class at once, and there is nothing stale to migrate when a rule changes.

---

## Two decisions worth knowing about

**Audio is re-encoded to MP3 in the browser.** Browsers disagree about recording formats: Chrome
and Firefox produce WebM/Opus, Safari produces MP4/AAC, and Safari could not *play* WebM until
version 18.4. A lesson recorded in Chrome would have been silent on an older iPhone. So audio is
decoded and re-encoded to 96 kbps mono MP3 before upload — one format, plays on anything, and
about 0.7 MB per minute. If the conversion fails for any reason the original is kept rather than
lost. Video is left alone; re-encoding video in a page isn't worth it.

**Uploads go through the Worker, not straight to R2.** Simpler, and it needs no extra API
credentials. The ceiling is Cloudflare's 100 MB request body limit, and the app rejects anything
over 90 MB with a clear message — far above a two-minute clip. If video ever grows past that,
switch to presigned URLs: create an R2 API token, add `aws4fetch`, and have the browser PUT
directly to R2. That's the only change needed.

---

## Local development

```bash
npx wrangler d1 execute sruti --local --file=./schema.sql
npm run dev
```

Google sign-in needs real credentials, so for local work there's a shortcut at
`/dev/login?email=you@example.com&role=teacher`. It only works when `DEV_LOGIN=true` is set
**and** the request comes from localhost. Put it in `.dev.vars`:

```
DEV_LOGIN=true
SESSION_SECRET=anything-for-local
```

`.dev.vars` is gitignored and never deployed. The route returns 404 in production even if the
variable somehow got set.

---

**Colours, per person.** The circle in the top bar opens a small menu: five palettes — Brass &
Peacock, Indigo & Copper, Palm & Sandalwood, Kumkum & Slate, Night Practice — and light, dark or
match-the-device. The choice is stored on the user, so it follows them from the practice-room
laptop to the phone, and the teacher's choice has nothing to do with any student's. It is
rendered server-side on the `<html>` element, so there is no flash of the old colours on load,
and it works with JavaScript off. Adding a palette means adding it in two places:
`PALETTES` in `views/layout.ts` and a `[data-palette]` block in `app.css`.

## Once it's live

`OPERATIONS.md` covers the automation: a push to `main` typechecks, runs the
time-zone tests, brings the database up to date **and then** deploys, and
confirms `/healthz` came back green. `GET /healthz` is signed out on purpose so
an external monitor can watch it. Two GitHub secrets and one variable are the
whole setup.

## Backups

`BACKUP.md` is the whole strategy. In short: D1's Time Travel covers the last
7 days on the free plan and needs no setup; `node scripts/backup.mjs`, run
weekly by launchd, puts the database dump *and* every recording into your
Google Drive folder (a GitHub Action does the database too, if the Mac may be
off); `scripts/restore.mjs` puts a dump back and checks every table's row count
against it, and `scripts/restore-media.mjs` puts the recordings back into R2.

The recordings are backed up against the dump the same run just took — the
database says which files matter, so an orphaned upload is never mistaken for
data and a file that has gone missing from R2 is reported rather than quietly
skipped. It copies forward and never back: a recording deleted in R2 stays in
the backup.

The backup deliberately does *not* run inside the Worker — the free plan's 10 ms
CPU and 50-subrequest limits make that unreliable as the library grows, and a
copy held in the account it protects doesn't answer the failure that matters.

## Costs

| | Free allowance | What this project uses |
|---|---|---|
| Workers | 100,000 requests/day | Nowhere near it |
| D1 | 5 GB, 5M row reads/day | A few megabytes |
| R2 | 10 GB stored, downloads free | ~4 MB per audio recording |

At 100 students with 30 recordings each you'd be at roughly 16 GB — about ten cents a month.
Playback never costs anything, which is the reason for R2 rather than S3 or Supabase.

The teacher's Students page shows current usage against the 10 GB line.

---

## Things deliberately left out

- **Students cannot upload.** The teacher records, students listen.
- **No listen tracking.** The teacher can't see whether a student played something.
- **No private teacher notes.** The lesson log is fully visible to the student, by choice.
- **No email notifications.** Students find new recordings by opening the site.

Each of these is a small change if you want it later, and each was a decision rather than an
oversight.
