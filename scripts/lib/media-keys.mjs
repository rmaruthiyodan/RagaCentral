/* ==================================================================
 * Which files in R2 does the database expect to exist?
 *
 * Read out of a D1 dump rather than by connecting to anything, so the
 * same answer can be got from last week's backup as from today's
 * database. Two tables hold an R2 key: recordings.r2_key ('rec/…') and
 * notes.image_key ('note/…').
 *
 * This lives on its own because two programs ask the question — the
 * backup and the audit — and a dump the audit understands but the
 * backup doesn't would be the worst kind of disagreement: each would
 * report a clean run while between them a file went unbacked.
 *
 * wrangler quotes table names — INSERT INTO "recordings" — so the match
 * allows for that. Getting this wrong reports "0 files expected" and a
 * clean bill of health, which is the worst possible way to be wrong;
 * that exact bug shipped once and is what this comment is here about.
 * ================================================================== */

/**
 * @param {string} sql  the text of a `wrangler d1 export` dump
 * @returns {Map<string, 'recording' | 'note image'>} key → what wants it
 */
export function mediaKeysFromDump(sql) {
  const wanted = new Map();
  for (const line of sql.split('\n')) {
    if (/^INSERT INTO ["`]?recordings["`]?/i.test(line)) {
      for (const m of line.matchAll(/'(rec\/[^']+)'/g)) wanted.set(m[1], 'recording');
    } else if (/^INSERT INTO ["`]?notes["`]?/i.test(line)) {
      for (const m of line.matchAll(/'(note\/[^']+)'/g)) wanted.set(m[1], 'note image');
    }
  }
  return wanted;
}
