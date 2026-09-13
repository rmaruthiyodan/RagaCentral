# Running it in Docker on your Mac

This runs the whole app — the site the teacher sees as **RP Sajeev Music** — on
your machine, with the database and every recording stored in a Docker volume. Nothing is sent to Cloudflare, and no Cloudflare
account is needed.

## Start it

From this folder, in Terminal:

```bash
docker compose up --build
```

The first build takes a couple of minutes. When it settles, open:

**http://localhost:8787**

To stop it, press Ctrl-C, or run `docker compose down` in another window.

## Getting in

You don't need Google credentials to look around. With `DEV_LOGIN=true` (the
default), open:

```
http://localhost:8787/dev/login?email=teacher@example.com&role=teacher
```

That signs you in as a teacher. Swap `role=student` and a different email to see
the student side. This shortcut only works over localhost, and it is off in a
real deployment.

To use real Google sign-in instead, copy `.env.example` to `.env`, put your
client ID and secret in it, and add this as an authorised redirect URI on the
same Google OAuth client:

```
http://localhost:8787/auth/callback
```

Google permits plain `http` for `localhost`, so this works without certificates.
Then set `DEV_LOGIN=false` in `.env` and restart.

## Your data

Everything — the SQLite database and every audio and video file — lives in a
Docker volume called `sruti_sruti-data`, mounted at `/app/.wrangler`.

- `docker compose down` stops the app and **keeps** your data.
- `docker compose down -v` deletes the volume and **everything in it**.

To back it up:

```bash
docker run --rm -v sruti_sruti-data:/data -v "$PWD":/out alpine \
  tar czf /out/sruti-backup.tgz -C /data .
```

## Two things that will bite you

**Recording only works over localhost.** Browsers only allow microphone access
in a "secure context" — HTTPS, or `localhost`. So `http://localhost:8787` on
this Mac can record, but opening `http://192.168.1.x:8787` from your phone on
the same wifi cannot; the record button will fail while everything else works.
Playback, uploads and notes are fine either way.

**Speaking a lesson note doesn't work in here by default.** Workers AI — the
engine behind the microphone — has no local simulator. Every other binding runs
on disk inside the container (D1 becomes a SQLite file, R2 a directory), but
`[ai]` is always remote: `wrangler dev` opens a connection to Cloudflare for it
before the Worker starts, and with no account it fails outright with

```
it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for
wrangler to work
```

The container is meant to run with no Cloudflare account at all, so the
entrypoint removes that binding when no `CLOUDFLARE_API_TOKEN` is present, says
so on startup, and carries on. The microphone is simply hidden; every other part
of the lesson log works exactly as it does deployed. `wrangler.toml` in the repo
is untouched — only the copy inside the running container.

To dictate from the container anyway, use the other engine. Sarvam is an
ordinary API call and needs no Cloudflare account, so put this in a `.env` file
beside `docker-compose.yml`:

```
DICTATE_PROVIDER=sarvam
SARVAM_API_KEY=your-key
SARVAM_MODEL=saaras:v4
```

Or pass a real `CLOUDFLARE_API_TOKEN` and the binding stays, Workers AI and all.

**This is not how your students reach it.** A container on your Mac is
reachable from your Mac. For students in other countries you would need the Mac
switched on permanently, a tunnel or port forwarding, and a real domain with a
certificate. Deploying to Cloudflare instead is one command, costs nothing at
your volumes, and gives you an address that just works — see the main README.
Use Docker to try things and show your teacher; use Cloudflare for the real thing.

Both run the same code, so nothing you do here is wasted.

## After changing the code

The image copies the source in at build time, so rebuild to pick up edits:

```bash
docker compose up --build
```

Schema changes need nothing extra. On every start the container prints four
steps and runs them in order:

```
→ 1/4 tables      creates anything missing
→ 2/4 columns     adds columns an existing database doesn't have yet
→ 3/4 indexes     created once those columns exist
→ 4/4 data        moves rows when what they mean has changed
```

All four are safe to re-run. Step 2 only ever adds — it never alters or drops a
column — and step 4 is written so that a second run finds nothing left to do, so
your data is not at risk from an upgrade.

## If it won't start

- **`port is already allocated`** — something else is on 8787. Change the first
  number in the `ports:` line of `docker-compose.yml` to e.g. `8080:8787`, then
  use http://localhost:8080.
- **Build fails pulling packages** — check Docker Desktop is running and has
  network access.
- **`it's necessary to set a CLOUDFLARE_API_TOKEN`** — a binding in
  `wrangler.toml` needs a real Cloudflare account. The one that does this is
  `[ai]`, and the entrypoint already strips it when no token is set; if you see
  this after adding a binding of your own, that binding is remote-only too.
- **Blank page or 500s** — `docker compose logs -f sruti` shows the Worker's own
  logs, including anything the app printed.
