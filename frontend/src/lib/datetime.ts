/**
 * Timezone-aware calendar helpers for the dashboard.
 *
 * The browser may be in any timezone (and a laptop left on UTC is a real case),
 * so "today" is computed in the application timezone with `Intl`, never with
 * `new Date().toISOString().split('T')[0]` — that expression yields the UTC date
 * and shows *yesterday* between 00:00 and 07:00 in Vietnam.
 */

export const APP_TIME_ZONE = process.env.NEXT_PUBLIC_APP_TIME_ZONE || "Asia/Ho_Chi_Minh";

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` for the current instant in the app timezone. */
export function todayKey(timeZone: string = APP_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function isValidDateKey(value: string | null | undefined): value is string {
  if (!value) return false;
  const match = DATE_KEY_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/** Shift a date key by N calendar days. */
export function shiftDateKey(dateKey: string, days: number): string {
  const match = DATE_KEY_RE.exec(dateKey);
  if (!match) return dateKey;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** Monday of the week containing `dateKey`. */
export function startOfWeekKey(dateKey: string): string {
  const match = DATE_KEY_RE.exec(dateKey);
  if (!match) return dateKey;
  const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return shiftDateKey(dateKey, weekday === 0 ? -6 : -(weekday - 1));
}

/**
 * Parse a `YYYY-MM-DD` key as a *local* Date for display only.
 * Using `new Date("2026-10-05")` would parse it as UTC midnight and render as
 * the previous day west of Greenwich; constructing from parts avoids that.
 */
export function dateKeyToDate(dateKey: string): Date {
  const match = DATE_KEY_RE.exec(dateKey);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** `05/10/2026` */
export function formatDateKey(dateKey: string, locale = "vi-VN"): string {
  return dateKeyToDate(dateKey).toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** `05/10` — compact axis label. */
export function formatDayMonth(dateKey: string, locale = "vi-VN"): string {
  return dateKeyToDate(dateKey).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

/** `05/10 – 11/10/2026` */
export function formatWeekRange(startKey: string, endKey: string, locale = "vi-VN"): string {
  return `${formatDayMonth(startKey, locale)} – ${formatDateKey(endKey, locale)}`;
}

/** `Tháng 10 2026` / `October 2026` */
export function formatMonthLabel(year: number, month: number, locale = "vi-VN"): string {
  return new Date(year, month - 1, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
}

/** Shift a `{year, month}` pair by N months, crossing year boundaries safely. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

/** `2026-10` value for an `<input type="month">`. */
export function monthInputValue(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parseMonthInput(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}
