#!/usr/bin/env node
/* ==================================================================
 * "Are you sure you meant production?"
 *
 * Run before anything that reaches the live Worker or the live
 * database. It refuses when you are not on main, unless you say so out
 * loud.
 *
 *   node scripts/guard-prod.mjs deploy
 *   node scripts/guard-prod.mjs "the schema"
 *
 * WHAT THIS DOES NOT PROTECT YOU FROM, and it is worth knowing:
 * typing `npx wrangler deploy` yourself. Nothing in this repository can
 * stop that — wrangler is a program on your machine and it does what it
 * is told. The guard sits on `npm run deploy` and `npm run db:remote`,
 * which is why those are the spellings worth getting into your fingers.
 *
 * The schema commands are the sharper edge, not the deploy. A deploy
 * that goes wrong is fixed by deploying again a minute later. A
 * migration applied to the wrong database has already happened.
 *
 * There is no dev deployment to divert you to — dev is tested in Docker,
 * on the machine you are sitting at. So production is the only remote
 * thing there is, which is the reason to be sure you meant it.
 *
 * Set SRUTI_ALLOW_PROD=1 for CI, which is on no branch at all.
 * ================================================================== */

import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const what = process.argv[2] || 'this';
const BOLD = '[1m';
const RED = '[31m';
const YEL = '[33m';
const OFF = '[0m';

if (process.env.SRUTI_ALLOW_PROD === '1') process.exit(0);

let branch = '';
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* Not a git checkout — a zip, or a CI box without history. Fall
     through to asking rather than guessing. */
}

if (branch === 'main') process.exit(0);

const where = branch ? `on branch ${BOLD}${branch}${OFF}` : 'outside a git checkout';

console.error(`
${RED}Hold on.${OFF} You are about to run ${BOLD}${what}${OFF} against ${BOLD}production${OFF}
— the site your teacher and students are using — while ${where}.

  ${YEL}To try a change, run it on your own machine:${OFF}
      docker compose up --build          then http://localhost:8787

  Production is only ever deployed from main, normally by pushing
  and letting the workflow do it.
`);

if (!process.stdin.isTTY) {
  console.error(`${RED}Refusing${OFF} — nothing here can ask you, so nothing here will guess.\n`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stderr });
rl.question(`Type ${BOLD}production${OFF} to go ahead, anything else to stop: `, (answer) => {
  rl.close();
  if (answer.trim() === 'production') {
    console.error('');
    process.exit(0);
  }
  console.error(`\n${RED}Stopped.${OFF} Nothing was changed.\n`);
  process.exit(1);
});
