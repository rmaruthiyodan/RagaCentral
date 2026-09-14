#!/usr/bin/env bash
# =====================================================================
# First deploy to Cloudflare, in two halves.
#
#   ./scripts/first-deploy.sh setup     everything up to a live site
#   ./scripts/first-deploy.sh google    sign-in, once Google has a client
#
# The split is not arbitrary. Google needs to be told the exact address
# that is allowed to receive a sign-in, and nobody knows that address
# until the first deploy has happened. So: put it up, read the address
# off the screen, tell Google, come back.
#
# Everything here is in README.md as separate steps. This runs them in
# the one order that works, refuses to carry on when a step has really
# failed, and is safe to run again — every step checks for what it is
# about to create.
#
# Your Cloudflare password is never typed here — `wrangler login` handles
# that in a browser, before you run this. The Google client secret is
# typed into a prompt that does not echo and handed straight to wrangler;
# the session secret is generated and piped to wrangler without ever
# being displayed. Nothing secret is written to disk or printed.
# =====================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); OFF=$(printf '\033[0m')

say()  { printf '\n%s==>%s %s\n' "$BOLD" "$OFF" "$1"; }
ok()   { printf '    %s✓%s %s\n' "$GRN" "$OFF" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$OFF"; }
warn() { printf '    %s!%s %s\n' "$YEL" "$OFF" "$1"; }
die()  { printf '\n%sStopped.%s %s\n\n' "$RED" "$OFF" "$1" >&2; exit 1; }

wr() { npx --yes wrangler "$@"; }

# ---------------------------------------------------------------------

# `wrangler whoami` exits 0 whether or not you are signed in — it reports
# the state in words and calls that a success. So read the words.
require_login() {
  say "Checking you are logged in to Cloudflare"
  local out
  out=$(wr whoami 2>&1 || true)
  if printf '%s' "$out" | grep -qi 'not authenticated'; then
    die "Not logged in to Cloudflare. Run:

    npx wrangler login

  That opens a browser. Sign in, approve, then run this script again."
  fi
  local who
  who=$(printf '%s' "$out" | grep -Eio '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | head -1 || true)
  ok "${who:-logged in}"
}

# D1: reuse the database if it is already there, create it if not, and
# write its id into wrangler.toml. The id is not a secret — it is meant
# to be committed, which is why it lives in the file rather than a var.
setup_d1() {
  say "Database"
  local id
  id=$(wr d1 list --json 2>/dev/null \
       | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
           try{const r=JSON.parse(s).find(d=>d.name==="sruti");if(r)process.stdout.write(r.uuid)}catch{}
         })' || true)

  if [ -n "$id" ]; then
    ok "sruti already exists"
  else
    note "creating it…"
    # If listing failed for any reason the database may still exist, and
    # creating it again is an error rather than a no-op. Tolerate that.
    wr d1 create sruti >/dev/null 2>&1 || true
    id=$(wr d1 list --json 2>/dev/null \
         | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
             try{const r=JSON.parse(s).find(d=>d.name==="sruti");if(r)process.stdout.write(r.uuid)}catch{}
           })' || true)
    [ -n "$id" ] || die "Created the database but could not read its id back. Run 'npx wrangler d1 list' and paste the id into wrangler.toml by hand."
    ok "created"
  fi

  if grep -q 'PUT_YOUR_D1_DATABASE_ID_HERE' wrangler.toml; then
    # A plain sed -i differs between macOS and Linux; node avoids the argument.
    node -e '
      const fs=require("fs");
      const f="wrangler.toml";
      fs.writeFileSync(f, fs.readFileSync(f,"utf8").replace("PUT_YOUR_D1_DATABASE_ID_HERE", process.argv[1]));
    ' "$id"
    ok "wrote the id into wrangler.toml"
    warn "commit that change — it belongs in the repo"
  else
    ok "wrangler.toml already has an id"
  fi
}

# R2 is the one step that can hard-stop you: Cloudflare wants a card on
# file before it will switch object storage on, even though 10 GB and
# all downloads are free and this app will not come close.
setup_r2() {
  say "Media bucket"
  if wr r2 bucket list 2>/dev/null | grep -q 'sruti-media'; then
    ok "sruti-media already exists"
    return
  fi
  if wr r2 bucket create sruti-media >/dev/null 2>&1; then
    ok "created sruti-media"
  else
    die "Could not create the R2 bucket.

  Almost always this means R2 is not switched on for the account yet.
  Open the Cloudflare dashboard, go to R2, and enable it — it asks for a
  card. Nothing here costs anything: 10 GB of storage is free and R2
  never charges for downloads, which is the whole reason it was chosen.

  Then run this script again."
  fi
}

set_teacher_email() {
  say "The first teacher"
  local current
  current=$(grep -E '^BOOTSTRAP_TEACHER_EMAIL' wrangler.toml | sed 's/.*= *"//;s/"//' || true)
  if [ "$current" != "teacher@example.com" ] && [ -n "$current" ]; then
    ok "already set to $current"
    return
  fi
  note "The Google address that becomes the teacher on its first sign-in."
  note "Everyone else who signs in waits for approval."
  printf '    Teacher Google address: '
  read -r email
  [ -n "$email" ] || die "Need an address for the first teacher."
  case "$email" in *@*.*) ;; *) die "\"$email\" does not look like an email address." ;; esac
  node -e '
    const fs=require("fs"); const f="wrangler.toml";
    fs.writeFileSync(f, fs.readFileSync(f,"utf8").replace(
      /^BOOTSTRAP_TEACHER_EMAIL = ".*"$/m, `BOOTSTRAP_TEACHER_EMAIL = "${process.argv[1]}"`));
  ' "$email"
  ok "set to $email"
  warn "commit that change too"
}

# Changing this later signs everyone out, which is the quickest way to
# revoke every session at once. Generated here so it is never typed,
# pasted, or left in a shell history.
set_session_secret() {
  say "Session secret"
  if wr secret list 2>/dev/null | grep -q 'SESSION_SECRET'; then
    ok "already set — leaving it alone (replacing it signs everyone out)"
    return
  fi
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' \
    | wr secret put SESSION_SECRET >/dev/null
  ok "generated and stored — it was never printed or written to a file"
}

# --remote asks "are you sure" before touching the live database. The flag
# that answers it is --yes (-y). Verified against the d1 execute definition
# in wrangler itself, not by grepping the bundle for the word "confirmation"
# — several other commands have a --skip-confirmation and this one does not.
apply_schema() {
  say "Database schema — four steps, and the order matters"
  local d1="d1 execute sruti --remote --yes"
  wr $d1 --file=./schema.sql   >/dev/null; ok "1/4 tables"
  node scripts/sync-schema.mjs --remote >/dev/null; ok "2/4 any missing columns"
  wr $d1 --file=./indexes.sql  >/dev/null; ok "3/4 indexes"
  wr $d1 --file=./backfill.sql >/dev/null; ok "4/4 data fixups"
  note "these same four are safe to re-run on every future upgrade"
}

gates() {
  say "Checks before anything goes live"
  npm run -s typecheck;   ok "types"
  npm test >/dev/null;    ok "time-zone assertions"
  npm run -s check:i18n >/dev/null; ok "Malayalam glossary"
}

# Wrangler asks "Would you like to register a workers.dev subdomain now?"
# the first time an account deploys — but only when it can see a terminal.
# It tests `process.stdin.isTTY && process.stdout.isTTY`, so capturing the
# output with $(...) makes stdout a pipe, the question is auto-answered
# "no", and it dies with a registration-declined error and a dashboard link
# that 404s. So this runs the deploy with the terminal attached and asks
# for the address afterwards, rather than reading it out of captured text.
deploy_and_check() {
  say "Deploying"
  note "If this is the account's first deploy, wrangler will ask you to pick"
  note "a workers.dev subdomain. Say yes — it is free, and it is the address"
  note "the site will live at. Short is good; students will see it."
  echo
  wr deploy || die "Deploy failed — the output is above."

  echo
  note "Wrangler printed the address just above, ending in .workers.dev"
  printf '    Paste it here to check the site is answering (or Enter to skip): '
  read -r URL || URL=""
  URL="${URL%/}"
  [ -n "$URL" ] || { warn "skipped the check — open the address in a browser yourself"; return; }
  case "$URL" in https://*) ;; *) URL="https://$URL" ;; esac

  say "Is it answering?"
  local i=0
  while [ $i -lt 20 ]; do
    if curl -fsS --max-time 5 "$URL/healthz" 2>/dev/null | grep -q '"ok":true'; then
      ok "$URL is up, and can reach both the database and the bucket"
      return
    fi
    i=$((i+1)); sleep 3
  done
  warn "no healthy answer from $URL/healthz yet — give it a minute and try it in a browser"
}

# ---------------------------------------------------------------------

cmd_setup() {
  require_login
  gates
  setup_d1
  setup_r2
  set_teacher_email
  set_session_secret
  apply_schema
  deploy_and_check

  local base="${URL:-https://sruti.<your-subdomain>.workers.dev}"
  cat <<EOF

$BOLD The site is up. Sign-in is the last piece.$OFF

 Google has to be told which address is allowed to receive a sign-in,
 and that address only existed as of a minute ago. In the Google Cloud
 console (https://console.cloud.google.com/):

   1. Create a project, any name.
   2. APIs & Services -> OAuth consent screen -> External. App name and
      your email is enough. You do not need it verified: while it is in
      Testing you add each student under Test users. Or publish it — an
      app that asks only for name and email needs no review.
   3. APIs & Services -> Credentials -> Create credentials
      -> OAuth client ID -> Web application.
      Under Authorized redirect URIs add exactly this:

$BOLD          $base/auth/callback$OFF

      Add http://localhost:8787/auth/callback too if you want to sign in
      while developing.
   4. Copy the client ID and the client secret.

 Then come back and run:

$BOLD     ./scripts/first-deploy.sh google$OFF

EOF
}

cmd_google() {
  require_login
  say "Google sign-in"
  note "These go straight to Cloudflare as secrets."
  note "This script does not store them or write them to a file."

  # The client ID is not a secret and is long enough to fat-finger, so it
  # echoes — you want to be able to see a truncated paste. The secret does not.
  printf '    Client ID (ends in .apps.googleusercontent.com): '
  read -r gid
  [ -n "$gid" ] || die "No client ID given."
  case "$gid" in
    *.apps.googleusercontent.com) ;;
    *) warn "that does not end in .apps.googleusercontent.com — check you copied the ID, not the secret" ;;
  esac

  printf '    Client secret: '
  read -rs gsec; printf '\n'
  [ -n "$gsec" ] || die "No client secret given."

  printf '%s' "$gid"  | wr secret put GOOGLE_CLIENT_ID >/dev/null;     ok "client ID stored"
  printf '%s' "$gsec" | wr secret put GOOGLE_CLIENT_SECRET >/dev/null; ok "client secret stored"
  unset gid gsec

  say "Done"
  note "Secrets take effect immediately — no redeploy needed."
  note "Open the site and sign in as the teacher address you named."
  note "If Google says redirect_uri_mismatch, the URI in the console does"
  note "not match the site exactly — it is case- and slash-sensitive."
}

case "${1:-}" in
  setup)  cmd_setup ;;
  google) cmd_google ;;
  *) cat <<EOF
Usage:
  ./scripts/first-deploy.sh setup     create everything and deploy
  ./scripts/first-deploy.sh google    add sign-in, after Google has a client

Run setup first. It tells you what to do in Google, then you run google.
Both are safe to run more than once.
EOF
     exit 1 ;;
esac
