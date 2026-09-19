import { istToInstant, inZone, expand, istToday, weekdayOf, addDays, prettyIst, prettyIstZ, zoneAbbr, istAbbr } from './src/tz.ts';

const check = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}\n         got: ${got}${ok ? '' : `\n        want: ${want}`}`);
  return ok;
};
let fails = 0;
const t = (l,g,w) => { if(!check(l,g,w)) fails++; };

console.log('=== a 7pm IST Tuesday class, seen from New York across the US DST change ===');
// US DST ends Sun 1 Nov 2026. Tue 27 Oct is EDT (UTC-4); Tue 3 Nov is EST (UTC-5).
const a = istToInstant('2026-10-27','19:00');
const b = istToInstant('2026-11-03','19:00');
t('27 Oct, New York time', inZone(a,'America/New_York').time, '9:30 am');
t('3 Nov, New York time (clocks went back)', inZone(b,'America/New_York').time, '8:30 am');

console.log('=== same class from London across the UK DST change (25 Oct 2026) ===');
t('20 Oct, London (BST)', inZone(istToInstant('2026-10-20','19:00'),'Europe/London').time, '2:30 pm');
t('27 Oct, London (GMT)', inZone(istToInstant('2026-10-27','19:00'),'Europe/London').time, '1:30 pm');

console.log('=== southern hemisphere: Sydney DST starts 4 Oct 2026 ===');
t('29 Sep, Sydney (AEST)', inZone(istToInstant('2026-09-29','19:00'),'Australia/Sydney').time, '11:30 pm');
t('6 Oct, Sydney (AEDT)', inZone(istToInstant('2026-10-06','19:00'),'Australia/Sydney').time, '12:30 am');

console.log('=== date rollover — the bug that makes someone miss a class ===');
const m = istToInstant('2026-09-10','07:00');   // Thursday 7am IST
const ny = inZone(m,'America/New_York');
t('7am IST Thu → New York weekday', ny.weekday, 'Wed');
t('7am IST Thu → New York time', ny.time, '9:30 pm');
// September: Sydney is AEST (+10), so 7pm IST = 11:30pm the same day.
t('7pm IST Thu → Sydney, still Thu in Sept', inZone(istToInstant('2026-09-10','19:00'),'Australia/Sydney').weekday, 'Thu');
// October: AEDT (+11) pushes the same class past midnight into Friday.
const sydDst = inZone(istToInstant('2026-10-08','19:00'),'Australia/Sydney');
t('7pm IST Thu → Sydney rolls to Fri once their DST starts', sydDst.weekday, 'Fri');
t('  ...at 12:30 am', sydDst.time, '12:30 am');

console.log('=== Perth never has DST; Kolkata never has DST ===');
t('Perth', inZone(istToInstant('2026-01-15','19:00'),'Australia/Perth').time, '9:30 pm');
t('Kolkata reads back as set', inZone(istToInstant('2026-01-15','19:00'),'Asia/Kolkata').time, '7:00 pm');

console.log('=== expand(): two weekly slots + a skip + a reschedule ===');
const slots = [
  { id:'s1', student_id:'u1', kind:'weekly', weekday:2, on_date:null, time_ist:'19:00', duration_min:60, active_from:null, active_until:null, label:null },
  { id:'s2', student_id:'u1', kind:'weekly', weekday:5, on_date:null, time_ist:'18:00', duration_min:60, active_from:null, active_until:null, label:null },
];
const exceptions = [
  { slot_id:'s1', on_date:'2026-09-15', action:'skip', new_date:null, new_time_ist:null, reason:'Onam' },
  { slot_id:'s2', on_date:'2026-09-11', action:'move', new_date:'2026-09-12', new_time_ist:'10:00', reason:'teacher travelling' },
];
const occ = expand(slots, exceptions, '2026-09-08', 14);
console.log(occ.map(o => `         ${o.date} ${o.time} ${o.slot.id}${o.moved?' (moved)':''}`).join('\n'));
t('two slots over two weeks, minus one skip', String(occ.length), '3');
t('the moved class lands on the new date', occ.find(o=>o.moved)?.date, '2026-09-12');
t('the skipped one is gone', String(occ.some(o=>o.date==='2026-09-15')), 'false');

const withSkipped = expand(slots, exceptions, '2026-09-08', 14, { includeSkipped:true });
t('includeSkipped shows it', String(withSkipped.filter(o=>o.skipped).length), '1');
t('skip keeps its reason', withSkipped.find(o=>o.skipped)?.reason, 'Onam');

console.log('=== a class moved across the edge of the window ===');
// The Friday class is moved into the following week. Ask for that following
// week alone: the occurrence was generated from a date *before* the window,
// so it only appears if expand scans wider than it reports.
const across = [
  { slot_id:'s2', on_date:'2026-09-11', action:'move', new_date:'2026-09-14', new_time_ist:'11:00', reason:'moved to Monday' },
];
const nextWeek = expand(slots, across, '2026-09-13', 7);
t('the class moved in from the week before is there',
  String(nextWeek.some(o => o.date === '2026-09-14' && o.moved)), 'true');
t('...at its new time', nextWeek.find(o => o.moved)?.time, '11:00');
// And it must not still be sitting on the date it left.
const weekItLeft = expand(slots, across, '2026-09-06', 7);
t('it is gone from the week it left', String(weekItLeft.some(o => o.date === '2026-09-11')), 'false');
t('nothing is duplicated', String(nextWeek.filter(o => o.date === '2026-09-14').length), '1');

console.log('=== opening one class by the date it was due ===');
// The class page links by the date a class was *originally* due, because
// that is how an exception is keyed. Expanding a one-day window there has
// to find the class even though it now happens on another day — this is
// the regression that made a rescheduled class 404.
const dueDay = expand(slots, across, '2026-09-11', 1, { includeSkipped: true, by: 'originalDate' });
t('the moved class is found from its original date', String(dueDay.length), '1');
t('...and reports where it actually happens', dueDay[0]?.date, '2026-09-14');
t('...and remembers where it came from', dueDay[0]?.originalDate, '2026-09-11');
// The default window still means "what lands here", or the calendar shows
// a class twice: once where it was, once where it went.
t('the default window does not find it there',
  String(expand(slots, across, '2026-09-11', 1, { includeSkipped: true }).length), '0');
// A class that never moved is found either way.
t('an ordinary class, by original date',
  String(expand(slots, [], '2026-09-15', 1, { by: 'originalDate' }).length), '1');

console.log('=== helpers ===');
t('weekdayOf 2026-09-08', String(weekdayOf('2026-09-08')), '2');
t('addDays across month end', addDays('2026-09-30', 1), '2026-10-01');
t('prettyIst midnight', prettyIst('00:30'), '12:30 am');
t('prettyIst noon', prettyIst('12:00'), '12:00 pm');

console.log('=== naming the zone, which is the whole point of showing one ===');
/* A time with no zone on it is either right or five hours wrong, and
   nothing on the page says which. The obvious Intl call answers
   "GMT+5:30" and "GMT+8" for the two zones this school actually uses,
   because CLDR keeps a zone's letters only in the locales that use
   them. These assertions are here to catch a future runtime, or a
   future "simplification", quietly going back to offsets. */
t('India', zoneAbbr('Asia/Kolkata', new Date('2026-09-19T12:00:00Z')), 'IST');
t('Perth', zoneAbbr('Australia/Perth', new Date('2026-09-19T12:00:00Z')), 'AWST');
t('the teacher\u2019s own clock, cached', istAbbr(), 'IST');
t('a time carries it', prettyIstZ('19:00'), '7:00 pm IST');

/* Daylight saving is the reason the cache is keyed by offset and not by
   zone alone: the same place has two names and using one all year is
   wrong for half of it. */
const jan = new Date('2026-01-15T12:00:00Z');
const jul = new Date('2026-07-15T12:00:00Z');
t('Sydney in January is on summer time', zoneAbbr('Australia/Sydney', jan), 'AEDT');
t('Sydney in July is not', zoneAbbr('Australia/Sydney', jul), 'AEST');
t('New York in January', zoneAbbr('America/New_York', jan), 'EST');
t('New York in July', zoneAbbr('America/New_York', jul), 'EDT');
t('London in July', zoneAbbr('Europe/London', jul), 'BST');

/* inZone is what every schedule row actually calls. */
t('a student in Perth sees their own zone named',
  inZone(istToInstant('2026-09-22', '19:00'), 'Australia/Perth').abbr, 'AWST');
t('and one in New York sees theirs',
  inZone(istToInstant('2026-09-22', '19:00'), 'America/New_York').abbr, 'EDT');

/* Where the world genuinely has no abbreviation, an offset is honest
   and an invented acronym would not be. */
t('a zone with no name keeps its offset',
  /^(GMT|UTC)[+-]|^[A-Z]{2,5}$/.test(zoneAbbr('Asia/Hong_Kong', jul)) ? 'plausible' : zoneAbbr('Asia/Hong_Kong', jul),
  'plausible');
t('nonsense gets nothing rather than a guess', zoneAbbr('Not/AZone'), '');

console.log(fails ? `\n${fails} FAILURES` : '\nall passed');
process.exit(fails?1:0);
