# Running it once it's live

What happens on its own, what you set up once, and what still needs a human.
Backups have their own file — `BACKUP.md`.

---

## Set up once, in this order

**1. Two secrets in GitHub** (Settings → Secrets and variables → Actions):

| | |
|---|---|
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → Create → Custom. Permissions: **Workers Scripts · Edit**, **D1 · Edit**, **Workers R2 Storage · Edit**. Nothing else. |
| `CLOUDFLARE_ACCOUNT_ID` | In any Cloudflare dashboard URL |

**2. One variable** (same page, Variables tab): `SITE_URL` = your deployed
address, e.g. `https://sruti.ratish.workers.dev`. The deploy checks it after
publishing.

**3. Push to main.** `.github/workflows/deploy.yml` takes it from there.

**4. Turn on an R2 bucket lock.** R2 → `sruti-media` → Settings → Bucket lock →
90 days. Five minutes, and it makes accidental deletion impossible — including
by the app itself.

**5. Point a monitor at `/healthz`.** See below.

---

## What runs on its own

### Every push to main — deploy

Typecheck → time-zone tests → refuse destructive SQL → **bring the database up
to date** → deploy → confirm `/healthz` says ok.

The order matters more than the list. A new column has to exist before the code
that selects it starts serving, so the four schema steps run *before*
`wrangler deploy`, never after. Markdown-only commits don't deploy.

The destructive-SQL check greps the schema files for `DROP` and
`ALTER TABLE … DROP/RENAME` and fails the build. It is not clever — it is a
tripwire, so that dropping a column is something you do deliberately at a
terminal rather than something a merge does at 11pm.

If a deploy fails, nothing is half-applied in a dangerous way: the schema steps
only ever add, and the old Worker keeps serving until the new one publishes.

### Every Sunday night — backup

Exports the database, checks the dump isn't hollow, keeps it 90 days as an
artifact. With the media keys added, it also copies new recordings to Backblaze
and then **audits them**: every `r2_key` in the database is checked against the
bucket. A recording whose file has gone is silent data loss — nothing looks
wrong until a student presses play — and this is the only thing that looks.

Full details, and the Google Drive route, in `BACKUP.md`.

### Continuously — D1 Time Travel

On, free, nothing to configure. Seven days of history on the free plan.

---

## Watching it

`GET /healthz` is signed out on purpose so a monitor can call it without
credentials. It returns booleans and a timestamp — no counts, no names:

```json
{"ok":true,"db":true,"media":true,"ms":5,"at":"2026-09-10T02:09:21.867Z"}
```

`ok:false` with a 503 means the Worker is up but can't reach D1 or R2 — the
failure worth being told about. A timeout means the Worker itself is gone.

**Use an external monitor, not a GitHub Action.** A 5-minute cron in Actions
would burn most of the free monthly minutes to do worse than
[UptimeRobot](https://uptimerobot.com), whose free tier watches 50 monitors
every 5 minutes and emails you. Point it at `https://<your-site>/healthz`, set
"keyword" mode looking for `"ok":true`, and you're done.

**Cloudflare's own signals**, worth turning on while you're in the dashboard:
Workers → your Worker → Metrics shows errors and CPU; Notifications can email
you on a Worker error spike, and on R2 or D1 approaching a limit.

---

## What still needs a human

| | When | Where |
|---|---|---|
| Approve a new student | When someone signs in | The app, Approvals |
| Restore drill | Quarterly | `BACKUP.md` |
| Download a dump to your own disk | Monthly | Drive, or the Actions tab |
| Rotate `SESSION_SECRET` | If a laptop is lost | `wrangler secret put` — signs everyone out |
| Google OAuth test users | While the consent screen is in Testing | Google Cloud console |
| Check storage against the 10 GB line | Occasionally | The teacher's Students page shows it |

---

## When something is wrong

**The site is down.** Check `/healthz`. If it times out, look at
Workers → Logs in the dashboard — a Worker that throws on every request usually
means a bad deploy; `wrangler rollback` puts the previous version back in
seconds.

**`healthz` says `db:false`.** The Worker is fine, D1 isn't answering. Check the
Cloudflare status page before anything else. Nothing in the app writes without
D1, so no data is being lost while it's down.

**A student says a recording won't play.** Check whether it's a permissions
question first — the recording may simply not be shared with them, which looks
identical from their side. If it is shared, the weekly audit's MISSING list is
where a genuinely absent file shows up.

**A deploy failed on the schema step.** Nothing was published; the live app is
untouched. Read the error — `sync-schema.mjs` refuses columns it cannot add
safely (PRIMARY KEY, UNIQUE, NOT NULL without a default) and says so.
