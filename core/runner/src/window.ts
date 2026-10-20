import type { Ontology } from "@causeline/schema";
import { resolvePeriod, type PeriodInfo } from "./period.js";
import { toBuckets } from "./rows.js";
import { slotFilterFor, slotNamesOf } from "./seasonal.js";
import { sum } from "./stats.js";
import type { ToolIndex } from "./toolindex.js";
import type { Bucket, ToolCaller } from "./types.js";

type Failure = { error: "period_not_found" | "no_baseline" | "bad_range"; detail: string };

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const dayText = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Does this run ask for a date range (rather than a period label)? */
export const hasRange = (inputs: Record<string, unknown>) => String(inputs.start_date ?? "") !== "" || String(inputs.end_date ?? "") !== "";

/** What the data check needs to resolve the period a run asks about. */
export interface WindowArgs {
  tools: ToolCaller;
  index: ToolIndex;
  ontology: Ontology;
  metric: string;
  inputs: Record<string, string | number | boolean>;
  /** The time extent of the data, from the metric's extent tool. */
  extent: { start: string; end: string };
  stepId: string;
}

/**
 * Resolve the period a run is about, from a bucket label (`period: 2026-W07`) or from a date range
 * (`start_date`, `end_date`, whole days, both inclusive). Either way the result is the same PeriodInfo, so
 * everything after the data check is unchanged.
 *
 * A range is compared with earlier windows of its own length, cut from the day-level series. When a weekly cycle
 * is declared, the windows are placed a whole number of weeks apart, so a Wednesday is compared with earlier
 * Wednesdays and Monday to Wednesday with earlier Mondays to Wednesdays. The windows are then handed to
 * resolvePeriod as if they were periods, which also picks them like-for-like on calendar flags.
 */
export async function resolveWindow(a: WindowArgs): Promise<PeriodInfo | Failure> {
  const calendar = slotNamesOf(a.ontology).calendar;
  const baselineCount = Number(a.inputs.baseline);
  if (!hasRange(a.inputs) && String(a.inputs.period ?? "") === "") return { error: "bad_range", detail: "say which period: a period label, or a start and end date" };
  if (!hasRange(a.inputs)) {
    const top = a.ontology.time.levels[0];
    const series = toBuckets(await a.tools.call(a.index.series(a.metric, top), a.extent, a.stepId));
    const info = resolvePeriod(series, String(a.inputs.period), baselineCount, calendar);
    if (!("error" in info)) info.periodSeries = series;
    return info;
  }

  const start = String(a.inputs.start_date ?? "");
  const end = String(a.inputs.end_date ?? "");
  if (!ISO_DAY.test(start) || !ISO_DAY.test(end)) return { error: "bad_range", detail: `a date range needs both start_date and end_date as YYYY-MM-DD (got "${start}" and "${end}")` };
  if (Number.isNaN(Date.parse(`${start}T00:00:00Z`)) || Number.isNaN(Date.parse(`${end}T00:00:00Z`))) return { error: "bad_range", detail: `"${start}" to "${end}" is not a valid range of dates` };
  const [s, e] = [dayNumber(start), dayNumber(end)];
  if (e < s) return { error: "bad_range", detail: `the range ends (${end}) before it starts (${start})` };
  // the level a range is cut from: a level called day, else the second level; its buckets must not span days
  const levels = a.ontology.time.levels;
  const dayLevel = levels.includes("day") ? "day" : levels[1];
  if (!dayLevel) return { error: "bad_range", detail: "a date range needs a time level finer than the first (a day level) in the ontology" };

  const days = toBuckets(await a.tools.call(a.index.series(a.metric, dayLevel), a.extent, a.stepId));
  if (days.some((b) => b.bucket_start.slice(0, 10) !== b.bucket_end.slice(0, 10))) return { error: "bad_range", detail: `a date range needs a time level whose buckets stay inside one day, and "${dayLevel}" is not one` };
  const dated = days.map((b) => ({ b, n: dayNumber(b.bucket_start.slice(0, 10)) })).filter((x) => !Number.isNaN(x.n));
  if (dated.length === 0) return { error: "period_not_found", detail: "the data has no days" };
  const [first, last] = [dated[0].n, dated[dated.length - 1].n];
  if (s < first || e > last) return { error: "period_not_found", detail: `${start} to ${end} is not inside the data, which covers ${dayText(first)} to ${dayText(last)}` };

  const length = e - s + 1;
  const weekly = a.ontology.time.seasonality !== "none" && a.ontology.time.seasonality.cycles.includes("weekday");
  // under a week: whole weeks apart, so the same weekdays are compared (node queries then restrict the baseline to those weekdays)
  const step = weekly && length < 7 ? 7 : length;

  // windows, oldest first, each wholly inside the data; the last is the one asked about
  const windows: { label: string; from: number; to: number }[] = [];
  // the baseline reaches back up to twice its length (like-for-like picks); the contributions step judges a node against up to eight earlier windows too
  const reach = Math.max(2 * Math.max(1, baselineCount), Math.max(1, baselineCount) + 8);
  for (let k = reach; k >= 0; k--) {
    const [from, to] = [s - k * step, e - k * step];
    if (from >= first) windows.push({ label: `${dayText(from)}..${dayText(to)}`, from, to });
  }
  const buckets: Bucket[] = windows.map((w) => {
    const inside = dated.filter((x) => x.n >= w.from && x.n <= w.to).map((x) => x.b);
    const slots: Record<string, string | null> = {};
    for (const name of calendar) {
      const values = new Set(inside.map((b) => b.slots?.[name] ?? null));
      slots[name] = values.size === 1 ? [...values][0] : null;
    }
    const total = sum(inside);
    return {
      bucket: w.label,
      bucket_start: inside.map((b) => b.bucket_start).sort()[0] ?? "",
      bucket_end: inside.map((b) => b.bucket_end).sort().reverse()[0] ?? "",
      num: total.num,
      den: total.den,
      ...(total.sq !== undefined ? { sq: total.sq } : {}),
      slots,
    };
  });

  const label = `${start}..${end}`;
  const info = resolvePeriod(buckets, label, baselineCount, calendar);
  if ("error" in info) return info;
  info.periodSeries = buckets;

  // a range shorter than a week sits in only some weekdays: the baseline rows of node queries must too
  const current = dated.filter((x) => x.n >= s && x.n <= e).map((x) => x.b);
  const cycles = slotNamesOf(a.ontology).all.filter((n) => !calendar.includes(n));
  info.cycleFilter = slotFilterFor(current, cycles);
  info.notes.push(`date range ${label} (${length} day${length === 1 ? "" : "s"}) compared with ${info.baselineLabels.length} earlier window${info.baselineLabels.length === 1 ? "" : "s"} of the same length${step !== length ? ", a week apart so the same weekdays are compared" : ""}`);
  return info;
}
