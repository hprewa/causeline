import type { Bucket, Components } from "./types.js";
import { sum } from "./stats.js";

export interface Window {
  start: string;
  end: string;
}

export interface PeriodInfo {
  label: string;
  baselineLabels: string[];
  cur: Window;
  base: Window;
  curComponents: Components;
  baseComponents: Components;
  /** Baseline buckets then the period bucket, in time order. */
  trend: Bucket[];
  /** The baseline buckets themselves (the period's own slots are on `slots`). */
  baselineBuckets: Bucket[];
  /** The period bucket's slots (calendar flags are constant when the whole period agrees). */
  slots: Record<string, string | null>;
  /** True when the baseline periods were chosen to share the period's calendar flags. */
  likeForLike: boolean;
  notes: string[];
}

type Failure = { error: "period_not_found" | "no_baseline"; detail: string };

/**
 * Resolve a period label and its preceding baseline buckets from a series at
 * the period's own time level. Windows come from the data (each bucket's
 * first and last timestamp), so no calendar arithmetic is needed.
 *
 * With calendar attributes (a holiday, a peak) the baseline is chosen like-for-like: looking back
 * up to twice the baseline length, keep the periods whose flags equal the period's. With fewer than
 * two such periods it falls back to the immediately preceding ones and says so.
 */
export function resolvePeriod(series: Bucket[], label: string, baselineCount: number, calendar: string[] = []): PeriodInfo | Failure {
  const idx = series.findIndex((b) => b.bucket === label);
  if (idx < 0) {
    const have = series.map((b) => b.bucket);
    return { error: "period_not_found", detail: `period "${label}" not found; available: ${have[0]} .. ${have[have.length - 1]}` };
  }
  const period = series[idx];
  const notes: string[] = [];
  let baseline = series.slice(Math.max(0, idx - baselineCount), idx);
  let likeForLike = false;

  if (calendar.length > 0) {
    const sig = (b: Bucket) => calendar.map((c) => b.slots?.[c] ?? "~").join("|");
    const pool = series.slice(Math.max(0, idx - 2 * baselineCount), idx);
    const matched = pool.filter((b) => sig(b) === sig(period)).slice(-baselineCount);
    if (matched.length >= Math.min(2, baselineCount)) {
      likeForLike = true;
      if (matched.map((b) => b.bucket).join() !== baseline.map((b) => b.bucket).join()) {
        notes.push(`baseline periods chosen to share the period's calendar flags: ${matched.map((b) => b.bucket).join(", ")}`);
      }
      baseline = matched;
    } else if (pool.some((b) => sig(b) !== sig(period))) {
      notes.push(`fewer than two earlier periods share this period's calendar flags; the previous ${baseline.length} periods are the baseline`);
    }
  }
  if (baseline.length === 0) {
    return { error: "no_baseline", detail: `period "${label}" has no preceding periods to use as a baseline` };
  }
  return {
    label,
    baselineLabels: baseline.map((b) => b.bucket),
    cur: { start: period.bucket_start, end: period.bucket_end },
    base: { start: baseline[0].bucket_start, end: baseline[baseline.length - 1].bucket_end },
    curComponents: { num: period.num, den: period.den, ...(period.sq !== undefined ? { sq: period.sq } : {}) },
    baseComponents: sum(baseline),
    trend: [...baseline, period],
    baselineBuckets: baseline,
    slots: period.slots ?? {},
    likeForLike,
    notes,
  };
}
