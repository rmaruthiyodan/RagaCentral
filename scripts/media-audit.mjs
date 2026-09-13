#!/usr/bin/env node
/* ==================================================================
 * Does every recording still have its file, and every file a row?
 *
 *   rclone lsjson r2:sruti-media --recursive > objects.json
 *   node scripts/media-audit.mjs backup.sql objects.json
 *
 * Two directions, and they are not equally serious:
 *
 *   MISSING  a row in the database points at an object that is not
 *            there. The student presses play and gets nothing. This is
 *            data loss, and it is silent until someone tries.
 *
 *   ORPHAN   an object nobody references. Harmless except for the
 *            storage it occupies — usually an upload that failed
 *            after the file was written. Never deleted automatically:
 *            a bad audit that deletes is worse than the waste.
 * ================================================================== */

import { readFileSync } from 'node:fs';
import { mediaKeysFromDump } from './lib/media-keys.mjs';

const [dumpFile, objectsFile] = process.argv.slice(2);
if (!dumpFile || !objectsFile) {
  console.error(`
  usage: node scripts/media-audit.mjs <dump.sql> <rclone-lsjson.json>

    rclone lsjson r2:sruti-media --recursive > objects.json
`);
  process.exit(2);
}

const sql = readFileSync(dumpFile, 'utf8');

/* Keys the database expects — read out of the dump's INSERT rows by
   the same code the backup uses, so the two can never disagree about
   what needs to exist. */
const wanted = mediaKeysFromDump(sql);

if (!wanted.size) {
  console.error(`\n  Found no media keys in ${dumpFile}. Either this app has no`);
  console.error('  recordings yet, or the dump is not what this expects. Not a pass.\n');
  process.exit(1);
}

const objects = JSON.parse(readFileSync(objectsFile, 'utf8'));
const present = new Map();
for (const o of objects) {
  if (o.IsDir) continue;
  present.set(o.Path, o.Size ?? 0);
}

const missing = [...wanted.keys()].filter((k) => !present.has(k));
const orphans = [...present.keys()].filter((k) => !wanted.has(k));
const orphanBytes = orphans.reduce((n, k) => n + present.get(k), 0);

console.log(`\n  database expects   ${wanted.size} files`);
console.log(`  bucket holds       ${present.size} files\n`);

if (missing.length) {
  console.log(`  MISSING — ${missing.length} file(s) the app will fail to play:`);
  for (const k of missing.slice(0, 25)) console.log(`    ${wanted.get(k).padEnd(12)} ${k}`);
  if (missing.length > 25) console.log(`    …and ${missing.length - 25} more`);
  console.log('');
} else {
  console.log('  Every referenced file is in the bucket.\n');
}

if (orphans.length) {
  console.log(
    `  ORPHANS — ${orphans.length} file(s), ${(orphanBytes / 1048576).toFixed(1)} MB, referenced by nothing:`,
  );
  for (const k of orphans.slice(0, 10)) console.log(`    ${k}`);
  if (orphans.length > 10) console.log(`    …and ${orphans.length - 10} more`);
  console.log('\n  Nothing is deleted by this script. Check a few by hand first.\n');
}

/* Only a missing file is worth failing a job over. */
process.exit(missing.length ? 1 : 0);
