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
- **Blank page or 500s** — `docker compose logs -f sruti` shows the Worker's own
  logs, including anything the app printed.
