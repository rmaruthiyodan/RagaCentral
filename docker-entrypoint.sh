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
EOF

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
if [ "${DEV_LOGIN:-true}" = "true" ]; then
  echo "   no Google credentials needed to look around:"
  echo "   http://localhost:8787/dev/login?email=teacher@example.com&role=teacher"
fi

# --ip 0.0.0.0 so the port is reachable from outside the container.
exec npx wrangler dev --ip 0.0.0.0 --port 8787
