# RP Sajeev Music — Product Requirements

*Working name in the codebase: `sruti`. Last revised 12 September 2026.*

---

## How to read this

Four documents describe this project and they do not overlap:

| | |
|---|---|
| **PRD.md** (this one) | What the product is, who it is for, what it must do, and why. The decisions and what they cost. What is deliberately absent. What comes next. |
| **`docs-design-book.html`** | How it is built. Architecture, the data model, the access rules, the time-zone engine, the interface system. Written for someone who did not build it. |
| **`README.md`** | How to run it, deploy it and change it. |
| **`BACKUP.md` / `OPERATIONS.md`** | How to keep it alive and get it back. |

This document is the *what and why*; the design book is the *how*. Where a number
appears here — routes, tables, costs — it was counted from the code on the date above,
not remembered.

---

## 1. The problem

A Carnatic vocal teacher in Kerala teaches students who are no longer in Kerala. They
are in Dubai, New Jersey, London, Sydney. Lessons happen over video call; between
lessons the student is alone with whatever they can remember.

What was happening before:

- **Recordings went out over WhatsApp.** They scroll away. A student looking for the
  reference take of a krithi from three months ago has to scroll through three months
  of a chat thread, and the file has probably expired from the phone.
- **Notes were spoken and lost.** "Hold the gamaka longer before the arohanam" is said
  once, at the end of a class, and remembered for about a day.
- **Nobody could say where the last lesson stopped.** Each class began with five
  minutes of reconstructing the previous one.
- **Class times were worked out by hand, twice a year.** IST does not observe daylight
  saving; New York, London and Sydney all do, on different dates. Somebody was always
  an hour out, or a day out.

### Why the generic tools don't fit

- **WhatsApp / Google Drive** — no per-student permissions, no structure, nothing that
  knows what a *song* is. A shared Drive folder gives every student every recording.
- **A generic LMS** — priced per seat, built around courses, quizzes and cohorts. This
  is one teacher, individual lessons, and a repertoire rather than a curriculum.
- **A music-practice app** — built for the student's own practice, not for a teacher's
  library of reference takes with per-student sharing.

The gap is specific: **a private library of one teacher's recordings, organised by
song, given out per student, with a lesson log and a schedule that both sides can
trust.**

---

## 2. Goals

1. **A student can find any recording they have been given, in seconds, a year later.**
2. **A teacher can pick up exactly where the last lesson stopped**, without remembering.
3. **Nobody is ever an hour or a day out** about when a class is.
4. **The teacher can put a lesson into the system faster than into WhatsApp**, or he
   will not do it.
5. **It costs nothing to run** at the size of one teaching practice.
6. **A student sees only what is theirs**, including via a guessed URL.

### Non-goals

These are not failures of scope; they are decisions, listed in §7 with reasons.

- Not a marketplace, not multi-tenant SaaS, not a course platform.
- Not a practice-tracking or gamification tool.
- Not a video-call product — lessons happen on whatever the family already uses.
- Not a payments or invoicing system.

---

## 3. Constraints that shaped everything

Every significant design decision in this product traces back to one of these five.

**C1 — Free tiers only.** Budget is zero, permanently. This ruled out managed
databases with idle-timeouts, per-seat pricing, and any storage that charges egress.
It is why the stack is Cloudflare Workers + D1 + R2: R2 charges **nothing** for
downloads at any volume, and downloads are what scales here — sixty students replaying
4 MB files is ~12 GB a month from a 2 GB library.

**C2 — The teacher writes up lessons on an iPhone.** Not at a desk, not later. This
decided the entire shape of the Malayalam dictation feature (§5.8): Apple's dictation
has no Malayalam, and Safari's in-browser speech recognition borrows the same list, so
the only workable route is recording audio and transcribing it server-side.

**C3 — Students are scattered across time zones; the teacher is not.** IST is a fixed
UTC+05:30 and has never observed daylight saving. The students' zones mostly do. This
is why classes are anchored to a **wall time in India** and every student's local time
is computed **per occurrence**.

**C4 — Malayalam sits alongside English throughout.** Song titles, and now lesson
notes. Second-generation students abroad often speak Malayalam but do not read the
script, so Malayalam is paired with a transliteration or an English rendering rather
than replacing it.

**C5 — Two roles, one teacher, no admin layer.** There is no organisation, no billing,
no role editor. A teacher sees everything; a student sees their own things. Anything
that would need a third role was cut.

---

## 4. Users

### The teacher

Records lessons, keeps the song catalogue, logs what happened, decides who hears what.
Works from an iPhone after class and a Mac when doing anything bulk. Not a technical
user; will abandon anything that takes more taps than WhatsApp.

**What he needs, in the order he needs it:** where did we stop → what did we cover →
what should they practise → is the recording shared with the right person.

### The student (and, in practice, the student's parent)

Listens between lessons. Wants the right recording, slowed down, looped on the hard
phrase. Reads the note about what to practise. Needs to know when the next class is
**on their own clock**. Ages range from children whose parent operates the app to
adults abroad.

**What they need:** play the take, at 0.75×, from the phrase that is hard, and know
what to practise.

### Explicitly not users

There is no administrator, no school office, no second teacher with different
permissions. The schema allows multiple teachers sharing one roster — every recording
stores `uploaded_by` — but they are peers, not a hierarchy.

---

## 5. Requirements, as built

Each area states what it does, why it is that way, and how you would know it works.
Everything in this section exists and has been exercised.

### 5.1 Accounts and access

- Sign-in is **Google only**. No passwords, therefore no password reset, no credential
  storage, no breach surface.
- A new sign-in lands in **pending** and waits for the teacher to approve it. The first
  sign-in matching `BOOTSTRAP_TEACHER_EMAIL` becomes the teacher.
- Students have a status: `active | paused | graduated | ended`. **Nothing is ever
  deleted.** A student who stops still has their history.
- Sessions are signed cookies verified on every request.

**Acceptance:** a signed-out request to any teacher route redirects to sign-in; a
student POSTing to any teacher route is rejected without changing data; a pending user
sees a waiting page and nothing else.

### 5.2 The song catalogue

- **One shared catalogue**, not per-student copies. Songs (`sections` in the schema,
  for historical reasons) carry title, Malayalam title, raga, taala, composer.
- **Teacher-defined groups** rather than a fixed sarali → janta → alankaram
  progression, because a teacher's own grouping is the one he thinks in.
- A **91-song starter catalogue** in 10 groups can be loaded into an empty install with
  one button, idempotent on title + raga.
- Songs are **assigned** to students. `completed_at` marks one finished — the
  recordings stay available; it is not the same as unassigning.
- Search covers title, Malayalam title, raga, taala and composer, on the same screen.

**Acceptance:** searching a Malayalam title in Malayalam script finds the song; marking
a song finished moves it to "Finished" and its recordings still play.

### 5.3 Recordings

- **A recording belongs to a song, not to a student.** This is the decision the whole
  sharing model rests on: one reference take serves everyone learning the piece,
  instead of being copied per student.
- Recorded **in the browser** or uploaded. Audio is re-encoded to **160 kbps mono MP3**
  before upload — one format that plays on every phone including older iPhones, about
  1.2 MB a minute. Video is left as recorded and capped at two minutes.
- Every recording **must have a name**. An upload falls back to its filename; the
  record form will not save without one.
- Recordings carry a **part** (pallavi, anupallavi, charanam…) and a free-text
  description. The song page groups by part.
- Reorderable within their part.
- Playback offers **0.5×–1.25× pitch-preserved speed** and an **A–B loop**, which is
  what practising a phrase actually requires. Playback uses HTTP range requests, so
  seeking a long file does not download it.

**Acceptance:** a take recorded in Chrome plays on an old iPhone; 0.75× playback does
not change pitch; a 90-minute file seeks without a full download.

**Why 160 kbps.** 96 was the original setting and is transparent enough for one voice
at normal speed. But students slow a reference take to 0.5× and loop it, and that is
where a lower bitrate's smearing lands — in the same frequency range as the gamaka
detail they are listening for.

### 5.4 Notes

- A note belongs to a song, and optionally to **one recording within it** — "watch the
  gamaka at 0:42" lives with the take it is about.
- Notes carry a heading, body text and an optional image, so a photo of notation or a
  screenshot can be part of the note. An image can be pasted straight into the box.
- Notes are **downloadable** as a text file, and their images as image files.
- Reorderable within their list.

### 5.5 Who hears what

The access model, and the part most worth understanding.

- A recording or note is either for **everyone learning the song** (`visibility =
  'shared'`) or for **a named set of students** (`'chosen'`, with rows in
  `recording_shares` / `note_shares`). One item can go to any number of students
  **without being copied**.
- **A student sees every recording on their songs.** The ones not shared with them
  appear named but unplayable, under "Not yet shared with you" — so they know the
  library exists and can ask. The teacher, on the same page, gets **Unlock** on each
  locked row and **Lock** on each open one.
- Media has **no public URL**. Every byte passes the Worker after an access check;
  `/media/<id>` returns 403 to a student who is not entitled to it.
- The check is **fail-closed**: anything that is not exactly `'shared'` is treated as
  restricted, so a row left behind by a half-finished upgrade is checked against an
  empty share list and comes back false. The failure mode is a student who has to ask,
  never a student who hears something they should not.

| Situation | Sees it listed | Can play it | `/media/:id` |
|---|---|---|---|
| shared, song assigned | yes | yes | 200 |
| chosen, named | yes | yes | 200 |
| chosen, not named | yes, locked | no | 403 |
| song not assigned | no | no | 403 |
| signed out | no | no | 302 → sign in |

**Acceptance:** locking a recording that was shared with everyone leaves every *other*
assigned student able to play it, in the same transaction; a student guessing another
student's media URL gets 403.

### 5.6 The lesson log

- A **session is one dated class with one student**, possibly covering several songs.
- Logged **after** the class in one form — not started and stopped live.
- Three fields carry the value: **what you covered**, **where you stopped**, **what to
  practise**. Plus date, duration, songs touched, and whether the lesson finished or is
  ongoing.
- **`left_off` is the field that earns its keep.** It is pinned to the top of the
  student's page until the next lesson replaces it. Everything else in the log is
  history; this is the part that gets used.
- The whole log is **visible to the student**. Consequence, accepted deliberately:
  there is nowhere to write a private note about a student.

**Acceptance:** logging a lesson as ongoing pins it to the top of the student page
until marked finished; the student sees the same text the teacher wrote.

### 5.7 Scheduling

- **Weekly slots** per student (two 1-hour slots is the normal case; the schema allows
  any number) plus **one-off** classes.
- Every class is anchored to a **wall time in India**. IST is a fixed UTC+05:30, so
  turning "Tuesday 7pm" into an instant is arithmetic — no library, no rule table that
  goes stale. Each student's local time is computed **per occurrence** with `Intl`,
  which knows their zone's DST rules. `users.time_zone` holds an **IANA name**, never a
  numeric offset — an offset is wrong half the year.
- **Occurrences are computed on read, never stored.** Editing a slot corrects every
  future class at once and there is nothing stale to migrate.
- A single occurrence can be **skipped, moved, or marked missed**. Cancelled and missed
  are different states and must not look alike: a cancellation was planned, a missed
  class should have happened and did not.
- Views: a **week grid**, a day view, a list, and a month calendar of history per
  student. Every view shows both clocks and flags **"different day"**, which is the
  failure mode that actually makes someone miss a class.
- A student who is not active has **no future classes** — but every class they already
  had stays on the calendar, marked with their status.
- A **class screen** opens a single class in the order it is needed: both clocks →
  where the last lesson stopped → the songs to work on → the log form, pre-filled.

**Acceptance:** `test-tz.mjs` asserts against real transitions in New York (1 Nov),
London (25 Oct) and Sydney (4 Oct), date rollover in both directions, and a class moved
across a week boundary appearing in the week it landed in and not the one it left.

### 5.8 Speaking a lesson note in Malayalam

The most recent capability, and the one with the most constraint behind it.

**The problem.** The teacher writes up lessons on an iPhone. Apple's Dictation lists
only English (India) and Hindi among Indian languages — no Malayalam — and Safari's
in-browser speech recognition borrows that same list. So the phone cannot be asked to
understand Malayalam. (On Android, Gboard's voice typing would have handled it with no
code at all; on a Mac in Chrome, a browser speech API would have. Neither is the device
in question.)

**What it does.** Each of the three lesson fields has a **Speak it** button. Speak a
sentence, press again, and the **Malayalam** and an **English rendering** both appear
in the form. Speaking twice appends rather than replaces; anything already typed
survives.

**Nothing is saved until the teacher presses Save.** A transcript that gets a word
wrong costs a retry, not a lesson. This is the single most important property of the
feature: it fills in a form, it does not write to the database.

**Both languages are stored** — `covered_ml` beside `covered`, the way a song keeps
`title_ml` beside `title`. Wherever a lesson is read back, the Malayalam leads and the
English sits underneath, so a student abroad who does not read the script still
follows.

**Two interchangeable engines**, chosen by `DICTATE_PROVIDER`:

| | |
|---|---|
| `workers-ai` (default) | Whisper inside Cloudflare. Free at this volume — 10,000 neurons a day against 46.63 per audio minute is roughly 200 minutes daily. No new account. But Whisper is a general multilingual model and is markedly weaker on Indic languages. |
| `sarvam` | Built for Indian languages. ~₹30 per hour of audio. Earns it through **keyterms**: the Carnatic vocabulary *and this teacher's own song titles and ragas, read out of his catalogue*, so "gamaka" and "Vatapi Ganapatim" come back as themselves. Its `codemix` mode also matches how he actually speaks — Malayalam with the technical terms left in English. |

**Audio format.** The clip is decoded in the browser and re-encoded to **16 kHz mono
WAV** before upload — not what the browser recorded. Browsers record WebM/Opus (Chrome)
or MP4/AAC (Safari) and Sarvam accepts neither. 16 kHz mono is also what speech models
resample to internally, so it is both universally accepted and a *smaller* upload than
the original.

**Acceptance:** with no provider configured the button does not render and every form
still works by hand; `/healthz` reports which engine is live or names the reason it is
not; a clip that will not decode says so and leaves the text alone; a provider that
does not answer within 45 seconds gives up with a message rather than hanging.

**Unproven:** how good either engine actually is on this teacher's Malayalam. See §9.

### 5.9 The interface

- **Server-rendered HTML, no framework.** Every core flow — assigning a song, logging a
  lesson, sharing a recording, rescheduling a class — is a plain form post that works
  with JavaScript switched off. Four small scripts add only what markup cannot do:
  playback speed and A–B loop, browser recording with MP3 encoding, dictation, and
  remembering which sections you left open.
- **Everything long collapses.** Song groups, parts, each recording, the recorder
  itself. Plain `<details>`, so it works without JavaScript; the script only remembers
  what you left open, per browser, never sent to the server.
- **Five colour palettes and light/dark/match-device, per user.** Stored on the user,
  so it follows them between devices; the teacher's choice has nothing to do with a
  student's. Rendered server-side onto `<html data-palette>`, so there is no flash of
  the previous colours.
- **Malayalam sits alongside the transliteration** wherever a title appears, in its own
  face at its own line height.
- Works at 390px. No horizontal scroll at any width.

### 5.10 Operations

- **Deploy on push to main**: typecheck → time-zone tests → a destructive-SQL tripwire
  → the four schema steps against the live database → deploy → poll `/healthz`. The
  order matters: a column must exist before the code that selects it starts serving.
- **Schema upgrades are four ordered steps** — tables, then columns, then indexes, then
  data. `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
  new column would never arrive; `sync-schema.mjs` compares `schema.sql` against the
  live database and adds the difference. Adding a column to `schema.sql` is the whole
  task.
- **Weekly backup** of the database *and* the recordings into Google Drive.
  `scripts/backup.mjs`. The database dump is the manifest: each run reads every
  `r2_key` out of the dump it just took and fetches the ones Drive does not have — so
  it is incremental by construction, an orphaned upload is never mistaken for data, and
  a file the database expects but R2 has lost fails the run. Media copies forward and
  never back. Twelve weekly dumps retained.
- **`/healthz`** is signed out on purpose so an external monitor can call it: one row
  from D1, a one-object list from R2, and which dictation engine is live.
- D1's **Time Travel** covers the last 7 days on the free plan with no setup, and is
  the right first answer to "I deleted the wrong student".

**Why the backup does not run in the Worker:** the free plan allows 10 ms CPU and 50
subrequests per invocation, cron included. Serialising a few megabytes of rows spends
the first; twelve table reads plus the writes crowd the second. That design works at
twenty students and fails intermittently at eighty — the worst possible failure curve
for a backup. And a copy held inside the account it protects does not answer the
failure that matters.

---

## 6. Decisions and what they cost

| Decision | Because | What it cost |
|---|---|---|
| R2, not S3 or Supabase | Egress, not storage, is what scales here. R2 charges nothing for downloads at any volume. | A card on file with Cloudflare, for a bill that stays at zero. |
| Recordings belong to the song | One reference take serves everyone learning the piece; corrections for one student are the exception. | A sharing model — the price of not copying files. |
| Server-rendered HTML, no framework | A form post is understandable a year later, works on a bad connection, and has no build step to rot. | No client-side routing; a full page load per action. |
| Uploads through the Worker | Presigned URLs need a separate R2 token and more moving parts. | A 100 MB request ceiling — far above a two-minute clip. |
| The lesson log is fully visible to the student | What was covered and what to practise is exactly what a student needs between classes. | Nowhere to write a private note about a student. |
| Occurrences computed, not stored | Editing a slot corrects every future class at once. | Every schedule view does arithmetic on read. |
| Two dictation engines behind one interface | Nobody could say in advance whether the free one is good enough on Malayalam. | A provider abstraction, and a decision still open. |
| Google sign-in only | No passwords to store, reset or leak. | A Google account is required — fine for this roster, a hard stop for anyone without one. |

---

## 7. Deliberately out of scope

- **Students cannot upload.** The teacher records; students listen. Keeps the library
  authoritative and the moderation problem non-existent.
- **No listen tracking.** The teacher cannot see whether a student played something.
  This was asked and declined: it would change the relationship.
- **No email or push notifications.** Students find new recordings by opening the site.
  This is the first thing that would not be free — see §10.
- **No practice logging, streaks or gamification.** Not what a Carnatic teacher's
  relationship with a student is.
- **No payments, invoicing or attendance-for-billing.**
- **No public or marketing pages.** Every page requires sign-in;
  `<meta name="robots" content="noindex,nofollow">` throughout.

---

## 8. Non-functional requirements

**Cost.** $0/month at current and projected volumes. Storage math: 25 students × 20
audio ≈ 2.0 GB (free) · 60 × (25 audio + 2 video) ≈ 7.8 GB (free) · 100 × (30 audio +
3 video) ≈ 16.5 GB ≈ $0.10/month. Dictation adds ₹0–50/month depending on engine.

**Performance.** Server-rendered pages inside the Worker's 10 ms CPU budget. Media
streams from R2 with range support. No page depends on JavaScript to render.

**Privacy.** Media has no public URL. Every request is authenticated. Nothing is
tracked beyond what the app needs to function; there is no analytics of any kind. A
student's data is visible to the teacher and to that student, nobody else.

**Reliability.** Worst-case loss is one week of data. Database recovery is one command
and has been rehearsed against a deliberately damaged database — the drill found a real
bug in the restore script, which is what drills are for.

**Browser support.** Current Chrome, Safari, Firefox and Edge, desktop and mobile.
Older iPhones specifically: audio is MP3 rather than WebM for exactly this reason.
In-browser recording requires a secure context — HTTPS or `localhost` — which is a
constraint on any self-hosted deployment.

**Accessibility.** Semantic HTML throughout, real form labels, keyboard-operable
disclosures, visible focus, and a colour system with light and dark that both meet
contrast on body text.

**Scale ceiling.** Designed for 20–100 students, one practice. Nothing in the design
prevents 300; nothing in it anticipates 3,000.

---

## 9. What is not yet proven

Listed honestly, because a PRD that only records successes is not much use.

1. **It is not deployed.** The app runs in Docker on the teacher's Mac. Students cannot
   reach it. Everything else in this document is downstream of fixing that — see §10.
2. **No student has used it.** Every access rule has been tested by hand and by script;
   none has been tested by a fourteen-year-old in New Jersey at 9pm.
3. **Malayalam transcription quality is unmeasured.** Whisper's published Indic numbers
   are thin and Malayalam is among its weaker languages; Sarvam is built for the job but
   costs money. The provider abstraction exists precisely because this is unknown. One
   real dictation answers it.
4. **The 91-song starter catalogue has not been reviewed** by the teacher against what
   he actually teaches.
5. **The backup has not run unattended for a month.** It has been rehearsed end to end,
   including a restore, but not lived with.

---

## 10. What comes next

### Blocking everything else

**Deploy to Cloudflare.** One command, $0 at these volumes, a real address with a
certificate. Until this happens the product has one user. The alternatives — a
Cloudflare Tunnel from the Mac, or a VPS — both require the Mac to stay awake or a
second version of the app to maintain, and both need a real certificate anyway because
browsers refuse microphone access on plain HTTP.

### Near term, once it is live

1. **Settle the dictation engine.** Record one real lesson note. If the Carnatic
   vocabulary survives on Workers AI, stay free; if not, switch to Sarvam with keyterms.
   One environment variable either way.
2. **Review the starter catalogue** against the actual repertoire.
3. **Put the project in git.** It is currently copied between folders by hand, which
   has already cost a full debugging session chasing a four-day-old copy.
4. **Watch the first month of backups**, then run the quarterly restore drill.

### Medium term, in rough value order

1. **Reminders for upcoming classes.** The most-requested thing not built. Cloudflare
   Cron Triggers are free; *sending* email is not — this would be the first non-zero
   line in the budget. Worth pricing a transactional email service (~$0–10/month at
   this volume) against the missed-class problem it solves.
2. **A cross-student overview** — every ongoing lesson, everyone not seen in three
   weeks, on one screen. Currently that requires opening each student.
3. **Lesson counts on the roster**, so the Students list answers "how are we doing"
   without a click.
4. **A private teacher-only field** on a lesson. Blocked by the deliberate decision
   that the log is fully visible; would need a second, separate field with its own
   access rule rather than a flag.

### Parked, needing a decision rather than work

- **Malayalam transliteration input** — typing "gamakam" and getting ഗമകം. Only worth
  building if the teacher finds the plain Malayalam field awkward; dictation may have
  removed the need entirely.
- **A default palette.** Five exist and are per-user; none has been chosen as the app
  default.
- **A plain-Node port** (SQLite instead of D1, disk instead of R2), which would make
  the app runnable on any server at the cost of a second version to keep in step.
  Revisit only if Cloudflare is ruled out.

---

## Appendix A — the shape of it, in numbers

| | |
|---|---|
| Routes | 67 |
| Database tables | 12 (two of them joins) |
| Indexes | 16 |
| TypeScript | ~6,900 lines |
| Client JavaScript | ~970 lines, four files, no framework |
| CSS | ~1,210 lines, one file, tokens first |
| Starter catalogue | 91 songs in 10 groups |
| Colour palettes | 5, each light and dark, per user |
| Running cost | $0/month |

## Appendix B — the data model in one line each

`users` (role, status, IANA time zone, location, WhatsApp number, palette) ·
`groups` · `sections` = songs · `assignments` (student ↔ song) ·
`recordings` (belongs to a song; part, description, visibility) ·
`recording_shares` · `notes` (song-wide or pinned to one recording) · `note_shares` ·
`sessions` = one dated class (covered, **left_off**, next_focus, and each in Malayalam) ·
`session_sections` · `class_slots` (a wall time in India) ·
`slot_exceptions` (skip · move · missed, keyed by the original date)

## Appendix C — glossary, for a reader who is not a Carnatic musician

**Raga** — the melodic framework a piece sits in. **Taala** — its rhythmic cycle.
**Krithi** — a composed song, the main repertoire form. **Varnam**, **geetham** —
teaching forms of increasing difficulty. **Pallavi / anupallavi / charanam** — the
sections of a krithi, in order. **Sarali varisai, janta varisai, alankaram** — the
graded beginner exercises, in that order. **Sangati** — a variation on a phrase, added
progressively. **Gamaka** — the ornamentation, the sliding and shaking between notes;
the thing that is hardest to notate and easiest to hear. **Arohanam / avarohanam** —
the ascending and descending scale of a raga. **Sruti** — pitch, the tonic a singer
tunes to. **Tanpura** — the drone instrument that holds it.
