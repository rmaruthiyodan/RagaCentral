# Changing the code

`README.md` tells you what this is and how to run it. `PRD.md` tells you why it
exists. This file is for the next question: **you want to change something —
where does the change go, what must you not break, and how do you know you
haven't?**

Read the first two sections before your first change. The rest is a reference;
come back to it when you need a recipe.

---

## 1. The shape, in one page

There is no framework and no client-side app. Every page is a string of HTML
built on the server and sent whole. Four small scripts add behaviour to pages
that need it (`player.js`, `recorder.js`, `dictate.js`, `disclose.js`) and
nothing else runs in the browser.

A request goes through five things, always in this order:

```
  the browser
      │
      ▼
  src/index.ts          85 routes. Reads the request, runs the queries,
      │                 calls a view, returns HTML.
      ▼
  src/auth.ts           the guard on the route: are you signed in, which
      │                 project are you acting in, may you do this here
      ▼
  src/projects.ts       pid(c) — the id of the project this request acts in
      │
      ▼
  D1 (SQLite)           15 tables, schema.sql
      │
      ▼
  src/views/*.ts        template literals that return HTML
```

The views are pure functions. They take data and return a string; they never
query, never read cookies, never know what a request is. If a view needs
something, the route fetches it and passes it in. This is why the views can be
rendered in a test or a screenshot script without a server.

**Files, and what each is for**

| | |
|---|---|
| `src/index.ts` | Every route, and the queries they run. The biggest file, and deliberately so: the routes are the app. |
| `src/auth.ts` | Google sign-in, signed session cookies, and the four route guards. |
| `src/projects.ts` | The project boundary: who may act where, `pid(c)`, `acting(c)`, the hat chooser's data. |
| `src/types.ts` | Row shapes. A type here usually mirrors a table. |
| `src/tz.ts` | The time-zone engine. Slots, exceptions, occurrences, zone names. |
| `src/i18n/` | `index.ts` is the `t()` function; `ml.ts` is the Malayalam glossary. |
| `src/transcribe.ts` | Speech to text, for spoken lesson notes. |
| `src/views/` | One file per area. `layout.ts` is the page shell everything else goes inside. |
| `public/app.css` | The entire design system. No framework, no build step. |
| `schema.sql` / `indexes.sql` / `backfill.sql` | The database, in three files. See §5. |
| `scripts/` | The checkers, the deploy helper, the backup job. |

---

## 2. The five rules

These are the invariants. Each one exists because breaking it produced a real
bug, and each one has something that checks it. If you remember nothing else
from this file, remember these.

### Rule 1 — every query stays inside its project

A project is one teacher's practice. Every student, song, recording, note,
lesson and class belongs to exactly one, and nothing crosses. That boundary is
only as good as the weakest query, and there are 125 of them.

```ts
// wrong — returns every practice's songs
'SELECT * FROM sections WHERE id = ?'

// right
'SELECT * FROM sections WHERE id = ? AND project_id = ?'
```

The project id comes from `pid(c)`, never from the URL, a form field or a
cookie. `pid` throws if the route has no guard, which is a loud 500 in testing
rather than a quiet leak in production.

`users` is the exception and the trap: identity is global, so the table has no
`project_id` at all. A query that reads or writes a user has to reach the
project another way — by joining `project_members`. Getting this wrong leaks a
person's name, email and phone, which is worse than leaking song metadata.

Checked by `npm run check:scope`.

### Rule 2 — a role is a fact about a membership, not about a person

One Google account can be a teacher here and a student there. So "are you a
teacher?" is never a question about a person, only about a person *in a
project*. Never read `users.role` — the column still exists and nothing writes
it. Ask `acting(c).isTeacher`.

The four guards, all in `auth.ts`:

| guard | means |
|---|---|
| `requireUser` | signed in, and standing in some project |
| `requireTeacher` | a teacher of the project being acted in — or an admin who switched into it |
| `requireTeacherJson` | the same, but answers `fetch` with a status code instead of a redirect |
| `requireAdmin` | above every project: creating them, switching between them |

Every guard resolves the project *before* it answers, and sets `acting` on the
context. Skipping that order is how one teacher ends up looking at another's
students.

### Rule 3 — a view runs synchronously, from top to bottom

`t()` reads the current language from a module-level variable that `setLang()`
sets at the top of each view. That is only safe because **no view function
awaits anything**. Between an `await` and the line after it, another request
can run and change that variable.

So: views stay synchronous. If you find yourself wanting to `await` inside a
view, fetch the data in the route instead and pass it in.

The same reasoning is why the "you are visiting someone else's practice" banner
is passed down as an argument rather than held in a module variable: it is set
in a guard, and `await next()` is a yield.

### Rule 4 — ten milliseconds of CPU

On Cloudflare's free plan a Worker gets **10 ms of CPU per request**. Waiting on
the network is free and unlimited — a request may sit for thirty seconds waiting
for a model to answer — but computing for more than ten milliseconds gets the
request killed, and the browser sees a dead connection that looks exactly like a
timeout.

Ten milliseconds is a lot of ordinary work and no bulk data at all:

```
base64-encoding 30 s of WAV in the Worker        48 ms   ✗
base64-encoding 120 s of WAV in the Worker      137 ms   ✗
reading a 2 MB request body as a string          11 ms   ✗
handing an already-encoded 626 KB string on     2.5 ms   ✓
```

So: never transform audio, images or any megabyte-scale payload in the Worker.
The browser has CPU to spare — `dictate.js` encodes the MP3 and its base64
because of this rule. When a body might be large, check `content-length` and
refuse *before* reading it.

### Rule 5 — the entry module exports handlers, nothing else

`src/index.ts` is what the runtime loads. It reads that module's exports as
handlers, so an exported constant refuses to start the Worker at all:

```
Incorrect type for map entry 'LESSONS_PER_PAGE':
the provided value is not of type 'function or ExportedHandler'
```

Exported *functions* are fine. Exported values are a dead site, and typecheck
and tests both pass right up until deploy. Keep constants unexported, or put
them in another module.

---

## 3. How to know you haven't broken it

Five commands. Run all of them before you push; the deploy workflow runs the
first four itself and refuses to ship if any fails.

```bash
npm run typecheck      # ~3s   the views are strings, but the data still has shapes
npm test               # ~1s   real DST transitions, date rollover, zone names
npm run check:i18n     # <1s   a dropped %s in the Malayalam breaks a page silently
npm run check:scope    # <1s   every query names its project
npm run test:isolation # ~3min two real practices, one real D1, 274 assertions
```

**What each one actually proves.**

`check:i18n` matters more than it looks. To TypeScript every line of `ml.ts` is
just a string, so a `%s` dropped from a translation is invisible until the page
renders with a blank where a name should be.

`check:scope` reads every SQL statement in `index.ts` and the views and insists
it mentions `project_id` — or `project_members`, for `users`. It is not proof of
correctness: a query can name the column and compare it to the wrong thing. It
catches the failure that actually happens, which is forgetting. A statement that
genuinely needs no scoping says so for itself:

```ts
/* unscoped: the signed-in user setting their own time zone — one person
   keeps one clock, whichever teachers they learn from */
```

Every waiver is printed on every run, so the exceptions stay visible rather than
accumulating quietly.

`test:isolation` is the one that matters most and the one you will be tempted to
skip. It starts the real app on a real local D1, builds two complete practices
through the real HTTP routes, and then has teacher A try, one request at a time,
to touch every single thing that belongs to teacher B. Every attempt is asserted
on the status line **and** on the database — a redirect that quietly wrote the
row anyway is a leak, not a refusal. Project B's whole state is snapshotted
before the attacks and diffed after, so a write nobody thought to assert on
still fails the run.

**One warning about it:** the run edits `wrangler.toml` (it removes the `[ai]`
block, because Workers AI has no local simulator) and restores it afterwards. If
you kill it with anything that sends SIGTERM — `timeout`, a CI cancellation —
check `git diff wrangler.toml` before committing. It handles SIGTERM now, but
the habit is cheap.

**Looking at what you built.** The views are pure functions, so you can render
one with made-up data and open it, without a server or a database:

```bash
npx esbuild preview.mjs --bundle --platform=node --format=esm --outfile=/tmp/p.mjs
node /tmp/p.mjs
```

where `preview.mjs` imports the view, calls it with fixture data, and writes the
HTML to a file with `public/app.css` inlined. Several real bugs in this codebase
were found this way and would not have been found by reading the markup.

---

## 4. Recipes

### Add a page

1. Write the view in the right `src/views/` file. It takes data, returns a
   string, calls `setLang(user.lang)` first and `page(body, opts)` last.
2. Add the route in `src/index.ts` with the right guard.
3. Scope every query with `pid(c)`.
4. Put any new English through `t('...')` and add the Malayalam to
   `src/i18n/ml.ts`.

**Route order matters.** Hono matches in registration order, so a static path
must be registered before a parameterised one that would swallow it —
`/me/songs` before `/me/:secid`.

### Add a field to an existing table

1. Add the column to `schema.sql` — at the end of the table, with a default.
2. Add it to the matching type in `src/types.ts`.
3. Add it to the `SELECT`s that need it. `SELECT *` picks it up on its own.
4. Locally: `npm run db:local`. In production it goes out with the deploy.

`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
new column would never reach an existing database. `scripts/sync-schema.mjs`
is what closes that gap: it reads the columns out of `schema.sql`, asks the
database what it actually has, and issues `ALTER TABLE ADD COLUMN` for the
difference. It only ever adds.

**Changing or removing a column is different.** SQLite cannot drop a constraint
in place; it needs the table rebuilt. The deploy workflow refuses any `DROP` or
`ALTER TABLE … DROP/RENAME` in the schema files on purpose. Those are done by
hand, deliberately, with a backup taken first.

### Add a teacher action that writes something

1. `requireTeacher` on the route.
2. Read the form with `await c.req.formData()`.
3. Every `UPDATE`/`INSERT`/`DELETE` carries `project_id = pid(c)` in its
   `WHERE`, so an id from another practice matches nothing.
4. Redirect back with `?msg=` rather than rendering — a refresh should not
   repeat the write.
5. Add the attempt to the attack table in `scripts/test-isolation.mjs`. It is
   one line, and it is what proves the new route cannot be reached across the
   boundary.

### Add a string

English is the key:

```ts
t('Started')                       // → 'Started', or the Malayalam if there is one
t('started %s', fmtDate(d))        // → 'started 4 March'
t('%1$s of %2$s', page, pages)     // numbered when the order must change
```

Add the Malayalam to `src/i18n/ml.ts`. A missing line is not a bug — that phrase
just stays in English. Keep every `%s` that the English has. No apostrophes in
the Malayalam: the file is JavaScript and the strings are single-quoted.

### Paginate a long list

The lesson log is the worked example (`lessonPage` in `index.ts`). Four things
to get right, and three of them are easy to miss:

- `LIMIT`/`OFFSET` in SQL, not `max-height` in CSS. What is not on the page
  should never be fetched.
- The tally needs its own `COUNT`. "4 lessons" on page three is not a summary,
  it is a lie about the page size.
- Anything linking into the list by anchor has to survive paging. The calendar
  links `?on=<date>`, and the server works out which page that day falls on.
- Clamp the page number. `?lp=9999` should show the last page, not an empty one.

---

## 5. Things that will bite you

**The database is three files, applied in four steps.** `schema.sql` creates
what is missing, `sync-schema.mjs` adds columns to tables that already exist,
`indexes.sql` builds indexes, `backfill.sql` fills in data. The order matters:
an index on a column that does not exist yet fails the deploy.

**`backfill.sql` runs on every deploy**, so everything in it must be idempotent
and say so — fixed ids, `INSERT OR IGNORE`, `WHERE x IS NULL`. One rule in there
is deliberately standing rather than one-off: every admin is made a teacher of
every practice, which means removing yourself from one is undone by the next
deploy. Delete the statement, not the row.

**Secrets never go in `wrangler.toml`.** `.dev.vars` locally (gitignored, never
deployed), `npx wrangler secret put` in production. `wrangler.toml` is committed.

**`/dev/login` only exists locally.** `DEV_LOGIN=true` in `.dev.vars` plus a
request from localhost; it returns 404 in production even if the variable is
somehow set. It can make a teacher, a student or an admin:

```
/dev/login?email=you@example.com&role=teacher
/dev/login?email=you@example.com&admin=1
```

**The time-zone code looks strange for a reason.** A class is stored as a
weekday and a time in IST, never as a UTC instant, because the teacher's
intention is "Tuesdays at 7pm my time" and that survives everyone else's
daylight saving. `expand()` turns slots plus exceptions into actual
occurrences. Read the header of `src/tz.ts` before touching any of it.

**A test that edits a tracked file can commit for you.** See the SIGTERM
warning in §3. It has happened once, and it silently removed the `[ai]` binding
from `wrangler.toml` — clean typecheck, clean tests, green deploy, dictation
dead.

---

## 6. Shipping

```bash
git push origin main
```

That is the whole thing. The workflow runs typecheck, the time-zone tests, the
glossary check, and refuses destructive SQL; then brings the database up to date
in the four steps above; then deploys the Worker; then polls `/healthz` and
fails loudly if the site does not come back.

By hand, when you need it:

```bash
SRUTI_ALLOW_PROD=1 npm run db:remote    # database first, always
SRUTI_ALLOW_PROD=1 npm run deploy       # then the code
```

The order is the whole point: a column has to exist before the code that selects
it starts serving. Deploying code that reads a column the production database
does not have takes the site down at sign-in, which is exactly as bad as it
sounds.

`/healthz` answers without signing in, and says whether the database and bucket
are reachable, whether dictation is configured and why, and whether sign-in is
configured — names only, never values. It is the first thing to open when
something is wrong.
