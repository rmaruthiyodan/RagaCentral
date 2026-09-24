# Working in this repo

## Push order: dev, then main

Every change ships in two steps, in this order:

1. `git push origin <local>:dev` — runs `.github/workflows/dev.yml` (typecheck,
   `npm test`, the Malayalam glossary check, the destructive-SQL guard). This
   workflow holds no Cloudflare credential and names no Cloudflare resource,
   so it deploys nothing even by mistake.
2. `git push origin main` — runs `.github/workflows/deploy.yml`, which is the
   only thing that touches production: it re-applies schema.sql/indexes.sql/
   backfill.sql to the live D1 database, deploys the Worker, then polls
   `/healthz`.

Don't push straight to `main` and skip `dev` — `dev` is the checks-only dry
run, on purpose (see commit `db9ed72`, "No dev deployment — Docker is the dev
environment"). Local dev itself is Docker (`DOCKER.md`), not a Cloudflare
environment tied to the `dev` branch.

## This session's sandbox can't push at all

If you're an agent working from a cloud sandbox rather than the user's own
machine: `git push` to GitHub will likely be blocked outright (a 403 from an
egress proxy, or no push credentials available even where fetch works). Don't
try to work around that. Commit normally, then hand the commits to the user:

- `git bundle create <path>.bundle ^<last-known-good-sha> <branch>`, deliver
  it (e.g. `SendUserFile`), write it into their connected folder, then on
  their machine: `git fetch <bundle-path> refs/heads/<branch>:refs/remotes/bundle/<label>`
  and `git merge --ff-only`.
- The user runs the actual `git push origin <branch>:dev` and
  `git push origin main` themselves, from their own Terminal — a bridged
  shell to their machine may not carry their git credentials either, even
  when it can `fetch`.
