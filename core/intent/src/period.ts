import type { CalendarUnit, ComparisonSpec, IntentOption, PeriodSpec, ResolvedWindow } from "@causeline/schema";
import { addMonths, dayFrom, dayText, describeDays, endOfUnit, monthName, parseDay, partsOf, shiftUnit, startOfUnit } from "./calendar.js";

/** What relative periods are measured from, and the period labels the data itself uses. */
export interface PeriodContext {
  /** Day number of "today": periods never include it (it is not finished). */
  today: number;
  /** Labels of the data's top time level with the days they cover, for a person who names one ("2026-W07"). */
  labels: { label: string; start: number; end: number }[];
}

/** A resolved span of whole days, with how it was named. */
export interface Span {
  start: number;
  end: number;
  /** How the person's words read: "last week", "August 2026". */
  name: string;
  /** Whether the dates are worth showing next to the name (a relative name is, a written range is not). */
  showDates: boolean;
  /** Set when the span is exactly `count` whole calendar units. */
  unit?: CalendarUnit;
  count?: number;
  whole: boolean;
  label?: string;
  /** Its start is a convention (the first of the year), so data that begins later may cut it short. */
  clip?: boolean;
}

export type PeriodResult = { span: Span; notes: string[] } | { problem: string; options?: IntentOption[] };

const plural = (unit: string, n: number) => (n === 1 ? unit : `${unit}s`);
const dateText = (n: number) => {
  const p = partsOf(n);
  return `${p.d} ${monthName(p.m)} ${p.y}`;
};

function relativeName(unit: CalendarUnit, offset: number, count: number): string {
  if (offset === 1 && count === 1) return unit === "day" ? "yesterday" : `last ${unit}`;
  if (offset === 1) return `the last ${count} ${plural(unit, count)}`;
  if (offset === 0 && count === 1) return unit === "day" ? "today" : `this ${unit} so far`;
  if (offset === 0) return `the last ${count} ${plural(unit, count)} including this one so far`;
  if (count === 1) return `${offset} ${plural(unit, offset)} ago`;
  return `${count} ${plural(unit, count)}, ending ${offset} ${plural(unit, offset)} ago`;
}

/** Cut a span at the last finished day. Returns null if nothing of it has finished. */
function finish(start: number, end: number, yesterday: number): { start: number; end: number; whole: boolean } | null {
  if (start > yesterday) return null;
  return { start, end: Math.min(end, yesterday), whole: end <= yesterday };
}

export function resolveSpec(spec: PeriodSpec, ctx: PeriodContext): PeriodResult {
  const yesterday = ctx.today - 1;
  const notes: string[] = [];
  const done = (span: Span): PeriodResult => {
    if (!span.whole) notes.push(`${span.name} is cut at ${dateText(span.end)}, the last complete day`);
    return { span, notes };
  };

  switch (spec.kind) {
    case "range": {
      const [s, e] = [parseDay(spec.start), parseDay(spec.end)];
      if (s === null || e === null) return { problem: `"${spec.start}" to "${spec.end}" is not a pair of real dates` };
      if (e < s) return { problem: `the range ends (${spec.end}) before it starts (${spec.start})` };
      return done({ start: s, end: e, name: describeDays(s, e), showDates: false, whole: true });
    }
    case "relative": {
      const name = relativeName(spec.unit, spec.offset, spec.count);
      const lastStart = shiftUnit(startOfUnit(ctx.today, spec.unit), spec.unit, -spec.offset);
      const firstStart = shiftUnit(lastStart, spec.unit, -(spec.count - 1));
      const f = finish(firstStart, endOfUnit(lastStart, spec.unit), yesterday);
      if (!f) return { problem: `${name} has no complete day yet (today is not finished)` };
      return done({ ...f, name, showDates: true, unit: spec.unit, count: spec.count });
    }
    case "to_date": {
      const start = startOfUnit(ctx.today, spec.unit);
      const f = finish(start, endOfUnit(start, spec.unit), yesterday);
      if (!f) return { problem: `this ${spec.unit} has no complete day yet` };
      return done({ ...f, name: `${spec.unit} to date`, showDates: true, unit: spec.unit, count: 1, clip: true });
    }
    case "since": {
      const s = parseDay(spec.date);
      if (s === null) return { problem: `"${spec.date}" is not a real date` };
      if (s > yesterday) return { problem: `${dateText(s)} has not happened yet, or has no complete day` };
      return done({ start: s, end: yesterday, name: `since ${dateText(s)}`, showDates: true, whole: true });
    }
    case "calendar": {
      const { unit } = spec;
      if (unit === "year" && spec.year === undefined) return { problem: "a whole year needs the year" };
      if (unit !== "year" && spec.index === undefined) return { problem: `which ${unit}? A ${unit} needs its number` };
      if (unit === "quarter" && (spec.index! < 1 || spec.index! > 4)) return { problem: `there is no quarter ${spec.index}` };
      if (unit === "month" && (spec.index! < 1 || spec.index! > 12)) return { problem: `there is no month ${spec.index}` };
      const startIn = (year: number) => (unit === "year" ? dayFrom(year, 1, 1) : unit === "quarter" ? dayFrom(year, (spec.index! - 1) * 3 + 1, 1) : dayFrom(year, spec.index!, 1));
      // no year: the latest such unit that has begun
      let year = spec.year ?? partsOf(yesterday).y;
      if (spec.year === undefined && startIn(year) > yesterday) year -= 1;
      const start = startIn(year);
      const name = unit === "year" ? String(year) : unit === "quarter" ? `Q${spec.index} ${year}` : `${monthName(spec.index!)} ${year}`;
      const f = finish(start, endOfUnit(start, unit), yesterday);
      if (!f) return { problem: `${name} has not started yet` };
      return done({ ...f, name, showDates: false, unit, count: 1 });
    }
    case "label": {
      const want = spec.label.trim().toLowerCase();
      const hit = ctx.labels.find((l) => l.label.toLowerCase() === want);
      if (!hit) {
        const near = ctx.labels.filter((l) => l.label.toLowerCase().includes(want) || want.includes(l.label.toLowerCase())).slice(-5);
        return { problem: `the data has no period called "${spec.label}"`, options: near.map((l) => ({ value: l.label, label: `${l.label} (${describeDays(l.start, l.end)})` })) };
      }
      return { span: { start: hit.start, end: hit.end, name: hit.label, showDates: true, whole: true, label: hit.label }, notes };
    }
  }
}

/** The other period of a comparison. */
export function resolveAgainst(c: ComparisonSpec, primary: Span, ctx: PeriodContext): PeriodResult {
  switch (c.kind) {
    case "period":
      return resolveSpec(c.period, ctx);
    case "same_last_year": {
      const [start, end] = [addMonths(primary.start, -12), addMonths(primary.end, -12)];
      return { span: { start, end, name: "the same dates a year earlier", showDates: true, whole: true }, notes: [] };
    }
    case "previous": {
      const length = primary.end - primary.start + 1;
      if (primary.unit && primary.count) {
        const start = shiftUnit(primary.start, primary.unit, -primary.count);
        // a span cut short compares with the same number of days, not with a whole unit
        const end = primary.whole ? primary.start - 1 : Math.min(start + length - 1, primary.start - 1);
        const name = primary.count === 1 ? `the previous ${primary.unit}` : `the ${primary.count} ${primary.unit}s before`;
        return { span: { start, end, name, showDates: true, unit: primary.unit, count: primary.count, whole: primary.whole }, notes: [] };
      }
      return { span: { start: primary.start - length, end: primary.start - 1, name: "the period just before", showDates: true, whole: true }, notes: [] };
    }
  }
}

/** A span as the window the rest of the system works with. */
export function toWindow(s: Span): ResolvedWindow {
  const dates = describeDays(s.start, s.end);
  return {
    start: dayText(s.start),
    end: dayText(s.end),
    days: s.end - s.start + 1,
    description: s.showDates ? `${s.name} (${dates})` : s.whole ? s.name : `${s.name} so far (${dates})`,
    ...(s.label ? { label: s.label } : {}),
  };
}
