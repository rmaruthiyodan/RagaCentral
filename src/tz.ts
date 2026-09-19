/* The .ts is deliberate. test-tz.mjs runs this module under Node's type
   stripping, which resolves neither a missing extension nor a directory's
   index — and the bundler is happy either way. */
import { lang } from './i18n/index.ts';
/* ==================================================================
 * Time zones
 *
 * Every class is anchored to India, because that is where the teacher
 * is and it is the one fact that doesn't move. India has never observed
 * daylight saving, so IST is a fixed UTC+05:30 and converting a wall
 * time there into a real instant is plain arithmetic — no library, no
 * lookup table that goes stale.
 *
 * Students are the ones who move. Their side is computed per occurrence
 * with Intl, which knows each zone's daylight-saving rules, so a class
 * fixed at 7pm IST correctly shows as 9:30am one week and 10:30am the
 * next in New York when the clocks there change.
 *
 * The trap this avoids: storing a numeric offset per student. An offset
 * is right for about half the year.
 * ================================================================== */

export const TEACHER_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MIN = 5 * 60 + 30;

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A wall time in India → the actual instant it happens. */
export function istToInstant(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * 60_000);
}

/** Today's date in India, as YYYY-MM-DD. */
export function istToday(nowMs = Date.now()): string {
  return istDateOf(new Date(nowMs));
}

/** The Indian calendar date an instant falls on. */
export function istDateOf(instant: Date): string {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Day of week (0 = Sunday) for a YYYY-MM-DD date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Is this an IANA zone this runtime actually knows? Guards against a
 * browser reporting something exotic, or a hand-typed value.
 */
export function isValidZone(tz: string | null | undefined): boolean {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Naming a zone
 *
 * A time with no zone on it is a trap in a school that runs across six
 * of them. "6:30 pm" is either the right answer or five hours wrong,
 * and nothing on the page says which.
 *
 * The obvious call gives the wrong answer for most of the world:
 *
 *   Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
 *     Asia/Kolkata    -> "GMT+5:30"      wanted: IST
 *     Australia/Perth -> "GMT+8"         wanted: AWST
 *
 * because CLDR only carries a zone's letters in the locales that
 * actually use them. en-IN knows IST and not AWST; en-AU knows AWST and
 * not IST; en-US knows EDT and neither of the others. No single locale
 * knows them all.
 *
 * So ask several, and take the first that answers with letters rather
 * than an offset. A locale never invents an abbreviation it does not
 * have — it falls back to "GMT+8" — so the first letters-only answer is
 * a real one, and the order below only decides who gets asked first.
 * Where nobody has a name (Singapore in some builds, Hong Kong), the
 * offset stands, which is still better than nothing at all.
 * ------------------------------------------------------------------ */

const ABBR_LOCALES = ['en-IN', 'en-AU', 'en-NZ', 'en-US', 'en-GB', 'en-CA', 'en-ZA', 'en-SG', 'en'];

/** "GMT+5:30", "UTC-7" — an offset wearing a name badge, not a name. */
const IS_OFFSET = /^(GMT|UTC)[+-]/i;

/* Keyed by zone AND by the offset we already saw, so the two sides of a
   daylight-saving change are cached apart: Sydney is AEST in July and
   AEDT in January, and a cache that could not tell them apart would be
   wrong for half the year. A pure function of its key, so unlike most
   module state in this app it is safe across requests. */
const abbrCache = new Map<string, string>();

function rawAbbr(locale: string, tz: string, at: Date): string {
  return (
    new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  );
}

/**
 * The best name for a zone at an instant, given the offset-ish string
 * the caller already has.
 *
 * Takes `plain` rather than working it out, because every caller has
 * just built a formatter that produced it. Constructing another one per
 * call measured at 0.1 ms, which is nothing until a week calendar asks
 * sixty times and the Worker has ten milliseconds to spend.
 */
export function betterAbbr(tz: string, plain: string, at: Date): string {
  if (plain && !IS_OFFSET.test(plain)) return plain;

  const key = `${tz}|${plain}`;
  const hit = abbrCache.get(key);
  if (hit !== undefined) return hit;

  let best = plain;
  for (const locale of ABBR_LOCALES) {
    let v = '';
    try {
      v = rawAbbr(locale, tz, at);
    } catch {
      /* a locale this build does not carry */
    }
    if (v && !IS_OFFSET.test(v)) {
      best = v;
      break;
    }
  }
  abbrCache.set(key, best);
  return best;
}

/** What to call a zone when you have nothing else in hand. */
export function zoneAbbr(tz: string, at: Date = new Date()): string {
  if (!isValidZone(tz)) return '';
  let plain = '';
  try {
    plain = rawAbbr('en-GB', tz, at);
  } catch {
    return '';
  }
  return betterAbbr(tz, plain, at);
}

/**
 * "IST". Worked out once and kept, which is safe here and would not be
 * for any other zone: India has had no daylight saving since 1945, so
 * unlike Sydney or New York this answer does not depend on the date.
 */
let istAbbrCached: string | null = null;
export function istAbbr(): string {
  if (istAbbrCached === null) istAbbrCached = zoneAbbr(TEACHER_ZONE) || 'IST';
  return istAbbrCached;
}

export interface LocalTime {
  time: string;      // "9:30 am"
  weekday: string;   // "Mon"
  date: string;      // "8 Sep"
  iso: string;       // "2026-09-08" in that zone
  abbr: string;      // "EDT", "GMT+5:30"
}

/** How an instant reads on a particular person's clock. */
export function inZone(instant: Date, tz: string): LocalTime {
  const zone = isValidZone(tz) ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(instant);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour');
  const minute = get('minute');
  const dayPeriod = (get('dayPeriod') || '').toLowerCase();

  // A separate pass for the numeric date, so we can sort and compare.
  const isoParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

  return {
    time: `${hour}:${minute}${dayPeriod ? ' ' + dayPeriod : ''}`,
    weekday: get('weekday'),
    date: `${get('day')} ${get('month')}`,
    iso: isoParts,
    /* Not get('timeZoneName') as it stands: for most of the world that
       is "GMT+8" where there is a real name to be had. */
    abbr: betterAbbr(zone, get('timeZoneName'), instant),
  };
}

/* ------------------------------------------------------------------ *
 * Turning slots into actual classes
 * ------------------------------------------------------------------ */

export interface Slot {
  id: string;
  student_id: string;
  kind: 'weekly' | 'once';
  weekday: number | null;
  on_date: string | null;
  time_ist: string;
  duration_min: number;
  active_from: string | null;
  active_until: string | null;
  label: string | null;
}

export interface SlotException {
  slot_id: string;
  on_date: string;
  /** skip = planned cancellation · missed = it should have happened and didn't · move = rescheduled */
  action: 'skip' | 'move' | 'missed';
  new_date: string | null;
  new_time_ist: string | null;
  reason: string | null;
}

export interface Occurrence {
  slot: Slot;
  /** The date this class was originally scheduled for, in IST. Identifies the exception. */
  originalDate: string;
  /** Where it actually lands after any reschedule. */
  date: string;
  time: string;
  instant: Date;
  moved: boolean;
  skipped: boolean;
  missed: boolean;
  reason: string | null;
}

/**
 * Expand slots into real classes across a window of Indian dates.
 * Occurrences are computed rather than stored: a slot edited today
 * corrects every future class at once, and there are no stale rows to
 * migrate when a rule changes.
 */
export function expand(
  slots: Slot[],
  exceptions: SlotException[],
  fromDate: string,
  days: number,
  opts: {
    includeSkipped?: boolean;
    /**
     * Which date the window applies to.
     *
     * 'date' (the default) answers "what lands in these days" — what a
     * calendar shows. A class moved out of the window is not in it; one
     * moved in, is.
     *
     * 'originalDate' answers "the class that was due on these days,
     * wherever it ended up". The class page needs this: its link is
     * keyed by the date the class was originally due, which is also how
     * an exception is keyed, so the link survives a reschedule.
     */
    by?: 'date' | 'originalDate';
  } = {},
): Occurrence[] {
  const exByKey = new Map(exceptions.map((e) => [`${e.slot_id}|${e.on_date}`, e]));
  const out: Occurrence[] = [];

  // A moved class is generated while scanning the date it was *due*, but it
  // lands on another date — possibly outside the window being asked for. So
  // the scan runs wider than the window and the result is trimmed to it,
  // which is what lets a class moved from last Friday show up on the Monday
  // the teacher actually asked about.
  const PAD = 14;
  const scanFrom = addDays(fromDate, -PAD);
  const lastDate = addDays(fromDate, days - 1);

  for (let i = 0; i < days + PAD * 2; i++) {
    const date = addDays(scanFrom, i);
    const dow = weekdayOf(date);

    for (const slot of slots) {
      const matches =
        slot.kind === 'weekly' ? slot.weekday === dow : slot.on_date === date;
      if (!matches) continue;
      if (slot.active_from && date < slot.active_from) continue;
      if (slot.active_until && date > slot.active_until) continue;

      const ex = exByKey.get(`${slot.id}|${date}`);

      // A cancelled class is hidden by default but kept for the day and
      // calendar views; a missed one is always shown, because "this didn't
      // happen" is a fact about the past worth seeing.
      if (ex?.action === 'skip' || ex?.action === 'missed') {
        const isMissed = ex.action === 'missed';
        if (opts.includeSkipped || isMissed) {
          out.push({
            slot, originalDate: date, date, time: slot.time_ist,
            instant: istToInstant(date, slot.time_ist),
            moved: false, skipped: !isMissed, missed: isMissed, reason: ex.reason,
          });
        }
        continue;
      }

      const date2 = ex?.action === 'move' ? (ex.new_date ?? date) : date;
      const time2 = ex?.action === 'move' ? (ex.new_time_ist ?? slot.time_ist) : slot.time_ist;

      out.push({
        slot,
        originalDate: date,
        date: date2,
        time: time2,
        instant: istToInstant(date2, time2),
        moved: !!ex && ex.action === 'move',
        skipped: false,
        missed: false,
        reason: ex?.reason ?? null,
      });
    }
  }

  // A class moved forward can land out of order, so sort by when it happens.
  const key = opts.by === 'originalDate' ? 'originalDate' : 'date';
  return out
    .filter((o) => o[key] >= fromDate && o[key] <= lastDate)
    .sort((a, b) => a.instant.getTime() - b.instant.getTime());
}

/** "7:00 pm IST" from "19:00" \u2014 the teacher's clock, named. */
export function prettyIstZ(time: string): string {
  return `${prettyIst(time)} ${istAbbr()}`;
}

/** "7:00 pm" from "19:00", for display. */
export function prettyIst(time: string): string {
  const [hh, mm] = time.split(':').map(Number);
  const period = hh < 12 ? 'am' : 'pm';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

/**
 * The locale the browser's own date tables should be read in.
 * Malayalam keeps Western digits — nobody here reads Malayalam numerals
 * off a calendar — so the month and weekday names change and the
 * numbers do not.
 */
function dateLocale(): string {
  return lang() === 'ml' ? 'ml-IN-u-nu-latn' : 'en-GB';
}

/** Human date for an IST date string: "Tue 8 Sep". */
export function prettyIstDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat(dateLocale(), {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(dt);
}

/**
 * "September 2026", or "Sep 2026" when short. Call it from a view, not
 * from a route: the language is only set for the duration of a render.
 */
export function monthLabel(ym: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(dateLocale(), {
    timeZone: 'UTC', month: style, year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * A short list of zones for the manual override. Anything the browser
 * reports is accepted too — this is a convenience, not a whitelist.
 */
export const COMMON_ZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland',
  'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Zurich',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Vancouver', 'Africa/Nairobi', 'Africa/Johannesburg',
  'Asia/Riyadh', 'Asia/Muscat', 'Asia/Kuala_Lumpur', 'Asia/Hong_Kong', 'UTC',
];
