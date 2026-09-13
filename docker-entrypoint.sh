#!/bin/sh
set -e

# Wrangler reads the Worker's secrets from .dev.vars, not from the process
# environment, so bridge whatever docker-compose passed in across to it.
# Written fresh on every start; never baked into the image.
cat > /app/.dev.vars <<EOF
DEV_LOGIN=${DEV_LOGIN:-true}
SESSION_SECRET=${SESSION_SECRET:-local-development-only-change-me}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}
BOOTSTRAP_TEACHER_EMAIL=${BOOTSTRAP_TEACHER_EMAIL:-teacher@example.com}
DICTATE=${DICTATE:-}
DICTATE_PROVIDER=${DICTATE_PROVIDER:-}
SARVAM_API_KEY=${SARVAM_API_KEY:-}
SARVAM_MODEL=${SARVAM_MODEL:-}
SARVAM_BASE=${SARVAM_BASE:-}
EOF

# ---------------------------------------------------------------------
# Workers AI has no local simulator.
#
# Every other binding runs on disk inside this container — D1 becomes a
# SQLite file, R2 becomes a directory. `[ai]` cannot: wrangler lists it as
# "Mode: remote" and opens a connection to Cloudflare before the Worker
# starts. With no CLOUDFLARE_API_TOKEN, and CI=true so it can't prompt,
# that fails outright and the app never comes up:
#
#   it's necessary to set a CLOUDFLARE_API_TOKEN environment variable
#   for wrangler to work
#
# The container's whole point is running with no Cloudflare account at
# all, so the binding is removed here unless a token was passed in. The
# deployed Worker keeps it — wrangler.toml is untouched in the repo, only
# in this container's copy.
# ---------------------------------------------------------------------
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && grep -q '^\[ai\]' /app/wrangler.toml; then
  awk '
    /^\[ai\]$/      { skip = 1; next }
    skip && /^$/     { skip = 0; next }
    skip             { next }
                     { print }
  ' /app/wrangler.toml > /app/wrangler.toml.tmp && mv /app/wrangler.toml.tmp /app/wrangler.toml
  AI_OFF=1
fi

# The database is brought up to date in four steps, and the order matters.
#
#   1. Tables.  CREATE TABLE IF NOT EXISTS — creates anything missing, and does
#      nothing at all to a table that already exists.
#   2. Columns. Precisely because step 1 does nothing to an existing table, a
#      column added in a newer version would never arrive. sync-schema compares
#      schema.sql against the live database and adds the difference.
#   3. Indexes. Last of the structure, because an index over a column added in
#      step 2 cannot be created before that column exists. Putting these in
#      schema.sql is what caused "no such column: visibility" on upgrade.
#   4. Data.    Structure alone isn't always enough: when the meaning of
#      existing rows changes, they have to be moved. Every statement in
#      backfill.sql is written to be safe on a second run.

echo "→ 1/4 tables"
npx wrangler d1 execute sruti --local --file=./schema.sql >/dev/null

echo "→ 2/4 columns"
node scripts/sync-schema.mjs

echo "→ 3/4 indexes"
npx wrangler d1 execute sruti --local --file=./indexes.sql >/dev/null

echo "→ 4/4 data"
npx wrangler d1 execute sruti --local --file=./backfill.sql >/dev/null

echo "→ Sruti is at http://localhost:8787"

# Say plainly whether the microphone will be there, and if not, why. This is
# the one setting whose effect isn't visible until you go looking for a button
# that isn't there, so it gets said out loud on every start.
case "${DICTATE_PROVIDER:-}" in
  sarvam)
    if [ -n "${SARVAM_API_KEY:-}" ]; then
      echo "   speaking a lesson note: on, via Sarvam"
    else
      echo "   speaking a lesson note: OFF — DICTATE_PROVIDER=sarvam reached the"
      echo "     container but SARVAM_API_KEY is empty. Check your .env sits next"
      echo "     to docker-compose.yml, and recreate: docker compose up -d --build"
    fi
    ;;
  ''|workers-ai)
    if [ -n "${AI_OFF:-}" ]; then
      echo "   speaking a lesson note: OFF — Workers AI needs a Cloudflare account"
      echo "     and this container runs without one. Put DICTATE_PROVIDER=sarvam"
      echo "     and SARVAM_API_KEY in a .env beside docker-compose.yml; that one"
      echo "     is a plain API call and works in here. Nothing else is affected."
    else
      echo "   speaking a lesson note: on, via Workers AI"
    fi
    ;;
  *)
    echo "   speaking a lesson note: OFF — DICTATE_PROVIDER=\"${DICTATE_PROVIDER}\" is"
    echo "     not a known engine. Use workers-ai or sarvam."
    ;;
esac
if [ "${DICTATE:-}" = "off" ]; then
  echo "   (and DICTATE=off is set, which hides it regardless)"
fi
if [ "${DEV_LOGIN:-true}" = "true" ]; then
  echo "   no Google credentials needed to look around:"
  echo "   http://localhost:8787/dev/login?email=teacher@example.com&role=teacher"
fi

# --ip 0.0.0.0 so the port is reachable from outside the container.
exec npx wrangler dev --ip 0.0.0.0 --port 8787
