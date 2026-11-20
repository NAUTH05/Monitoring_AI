/**
 * Timezone-aware calendar-date helpers.
 *
 * The backend host may run in any timezone (the dev box is GMT+7, a Linux VPS is
 * often UTC), so calendar-day boundaries are ALWAYS computed in the application
 * timezone rather than the process timezone. Every range returned here is
 * half-open: `[startUtc, endUtcExclusive)`.
 *
 * Why half-open: a `lte: 23:59:59` bound silently drops events in the last
 * second (and anything with milliseconds), and `lte: <midnight>` drops the whole
 * final day. `lt: <next midnight>` has neither problem.
 *
 * No date library: `Intl` is built into Node 20 and is DST-correct, unlike a
 * hardcoded "+07:00" offset.
 */

/** Application timezone. Overridable, defaults to the deployment locale. */
export const APP_TIME_ZONE = normalizeTimeZone(process.env.APP_TIME_ZONE);

function normalizeTimeZone(value: string | undefined): string {
  const candidate = (value ?? '').trim();
  if (!candidate) return 'Asia/Ho_Chi_Minh';
  return isValidTimeZone(candidate) ? candidate : 'Asia/Ho_Chi_Minh';
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    // Throws RangeError for an invalid IANA name.
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateRangeError';
  }
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` for an instant, in `timeZone`. */
export function dateKeyInTimeZone(date: Date, timeZone: string = APP_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** Today's calendar date in the application timezone. */
export function todayKey(timeZone: string = APP_TIME_ZONE): string {
  return dateKeyInTimeZone(new Date(), timeZone);
}

/** Offset (ms) of `timeZone` at the given instant: local = utc + offset. */
function offsetMsAt(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // Some engines render midnight as hour "24" with hour12:false.
  const hour = pick('hour') === 24 ? 0 : pick('hour');

  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), hour, pick('minute'), pick('second'));
  return asUtc - at.getTime();
}

/**
 * Convert a wall-clock time in `timeZone` to the matching UTC instant.
 * Two passes: the first estimate may land on the other side of a DST boundary,
 * the second pass corrects it.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string = APP_TIME_ZONE,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const first = guess - offsetMsAt(timeZone, new Date(guess));
  const corrected = guess - offsetMsAt(timeZone, new Date(first));
  return new Date(corrected);
}

/** Midnight (local) of a `YYYY-MM-DD` key, as a UTC instant. */
export function startOfDayUtc(dateKey: string, timeZone: string = APP_TIME_ZONE): Date {
  const { year, month, day } = parseDateKeyParts(dateKey);
  return zonedTimeToUtc(year, month, day, timeZone);
}

export interface DateKeyParts {
  year: number;
  month: number;
  day: number;
}

/**
 * Strictly validate a `YYYY-MM-DD` key. Rejects malformed input, impossible
 * dates (2026-02-30) and out-of-range years, so callers can answer 400 instead
 * of silently querying 1970 or an Invalid Date.
 */
export function parseDateKeyParts(value: string): DateKeyParts {
  const match = DATE_KEY_RE.exec(value.trim());
  if (!match) {
    throw new DateRangeError(`Invalid date "${value}" — expected YYYY-MM-DD`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1970 || year > 2999) throw new DateRangeError(`Year out of range in "${value}"`);
  if (month < 1 || month > 12) throw new DateRangeError(`Month out of range in "${value}"`);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) throw new DateRangeError(`Day out of range in "${value}"`);

  return { year, month, day };
}

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseDateKeyParts(value);
    return true;
  } catch {
    return false;
  }
}

/** Shift a date key by N days (calendar arithmetic on the key, not on instants). */
export function addDaysToKey(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKeyParts(dateKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Monday of the week containing `dateKey` (weeks run Mon..Sun). */
export function startOfWeekKey(dateKey: string): string {
  const { year, month, day } = parseDateKeyParts(dateKey);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  const back = weekday === 0 ? 6 : weekday - 1;
  return addDaysToKey(dateKey, -back);
}

/** Number of days in a month (1-12), leap years included. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new DateRangeError(`Month out of range: ${month}`);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface UtcRange {
  /** Inclusive start instant. */
  start: Date;
  /** Exclusive end instant. */
  endExclusive: Date;
  /** Inclusive first calendar day key. */
  startKey: string;
  /** Inclusive last calendar day key. */
  endKey: string;
}

/**
 * Range covering the calendar days `startKey..endKey` inclusive, in `timeZone`.
 * `endExclusive` is midnight of the day AFTER `endKey`.
 */
export function dayRangeUtc(
  startKey: string,
  endKey: string,
  timeZone: string = APP_TIME_ZONE,
): UtcRange {
  const start = startOfDayUtc(startKey, timeZone);
  const endExclusive = startOfDayUtc(addDaysToKey(endKey, 1), timeZone);

  if (endExclusive.getTime() <= start.getTime()) {
    throw new DateRangeError('Start date must be on or before the end date');
  }
  return { start, endExclusive, startKey, endKey };
}

/** Single calendar day. */
export function singleDayRange(dateKey: string, timeZone: string = APP_TIME_ZONE): UtcRange {
  return dayRangeUtc(dateKey, dateKey, timeZone);
}

/** Monday..Sunday week containing `dateKey`. */
export function weekRangeUtc(dateKey: string, timeZone: string = APP_TIME_ZONE): UtcRange {
  const startKey = startOfWeekKey(dateKey);
  const endKey = addDaysToKey(startKey, 6);
  return dayRangeUtc(startKey, endKey, timeZone);
}

/** Whole calendar month. */
export function monthRangeUtc(
  year: number,
  month: number,
  timeZone: string = APP_TIME_ZONE,
): UtcRange & { year: number; month: number } {
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    throw new DateRangeError(`Year out of range: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new DateRangeError(`Month out of range: ${month}`);
  }

  const startKey = `${year}-${String(month).padStart(2, '0')}-01`;
  const endKey = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
  return { ...dayRangeUtc(startKey, endKey, timeZone), year, month };
}

/** Every calendar day key in `startKey..endKey` inclusive. */
export function enumerateDateKeys(startKey: string, endKey: string): string[] {
  const keys: string[] = [];
  let cursor = startKey;
  // Hard stop: never build an unbounded axis.
  for (let i = 0; i < 4000; i += 1) {
    keys.push(cursor);
    if (cursor === endKey) break;
    cursor = addDaysToKey(cursor, 1);
  }
  return keys;
}

/**
 * Resolve optional `startDate` / `endDate` query values into a UTC range.
 * Omitted bounds stay unbounded (backward compatible with API consumers that
 * never sent a date). Invalid or inverted input throws `DateRangeError`.
 *
 * `startDate` alone means "from that day onwards"; `endDate` alone means "up to
 * and including that day" — the same meaning each parameter had before, but now
 * with whole-day and timezone-correct boundaries.
 */
export function resolveOptionalRange(
  startDate: unknown,
  endDate: unknown,
  timeZone: string = APP_TIME_ZONE,
): { start?: Date; endExclusive?: Date; startKey?: string; endKey?: string } {
  const hasStart = startDate !== undefined && startDate !== null && String(startDate).trim() !== '';
  const hasEnd = endDate !== undefined && endDate !== null && String(endDate).trim() !== '';

  if (!hasStart && !hasEnd) return {};

  if (hasStart && !hasEnd) {
    const startKey = String(startDate);
    parseDateKeyParts(startKey); // validates
    return { start: startOfDayUtc(startKey, timeZone), startKey };
  }

  if (!hasStart && hasEnd) {
    const endKey = String(endDate);
    parseDateKeyParts(endKey); // validates
    return { endExclusive: startOfDayUtc(addDaysToKey(endKey, 1), timeZone), endKey };
  }

  const range = dayRangeUtc(String(startDate), String(endDate), timeZone);
  return {
    start: range.start,
    endExclusive: range.endExclusive,
    startKey: range.startKey,
    endKey: range.endKey,
  };
}
