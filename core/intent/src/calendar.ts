import type { CalendarUnit } from "@causeline/schema";

/**
 * Whole-day calendar arithmetic on the UTC calendar. A day is a number (days since 1970-01-01) so spans add and
 * compare without time zones; weeks start on Monday.
 */

export const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real date written YYYY-MM-DD as a day number, or null ("2026-02-30" is not a date). */
export function parseDay(iso: string): number | null {
  if (!ISO_DAY.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const n = Math.floor(ms / DAY_MS);
  return dayText(n) === iso ? n : null;
}

export const dayText = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

const parts = (n: number) => {
  const d = new Date(n * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
const make = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);

/** 0 for Monday ... 6 for Sunday. */
export const weekdayIndex = (n: number) => (new Date(n * DAY_MS).getUTCDay() + 6) % 7;

export function startOfUnit(n: number, unit: CalendarUnit): number {
  const { y, m } = parts(n);
  switch (unit) {
    case "day":
      return n;
    case "week":
      return n - weekdayIndex(n);
    case "month":
      return make(y, m, 1);
    case "quarter":
      return make(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
    case "year":
      return make(y, 1, 1);
  }
}

/** The first day of the unit that is `by` units after the one starting at `start` (negative: before). */
export function shiftUnit(start: number, unit: CalendarUnit, by: number): number {
  const { y, m } = parts(start);
  switch (unit) {
    case "day":
      return start + by;
    case "week":
      return start + 7 * by;
    case "month":
      return make(y, m + by, 1);
    case "quarter":
      return make(y, m + 3 * by, 1);
    case "year":
      return make(y + by, 1, 1);
  }
}

/** The last day of the unit that starts at `start`. */
export const endOfUnit = (start: number, unit: CalendarUnit) => shiftUnit(start, unit, 1) - 1;

/** The same calendar date `months` earlier or later; a day that does not exist there (29 February) becomes the month's last. */
export function addMonths(n: number, months: number): number {
  const { y, m, d } = parts(n);
  const first = make(y, m + months, 1);
  return Math.min(first + d - 1, endOfUnit(first, "month"));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (m: number) => MONTHS[m - 1];

/** "2–8 February 2026", "26 January – 8 February 2026", "28 December 2025 – 3 January 2026", "Wednesday 11 February 2026". */
export function describeDays(start: number, end: number): string {
  const [a, b] = [parts(start), parts(end)];
  if (start === end) return `${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][weekdayIndex(start)]} ${a.d} ${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

export const partsOf = parts;
export const dayFrom = make;
