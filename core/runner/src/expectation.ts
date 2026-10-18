import type { Ontology } from "@causeline/schema";
import { decomposeBuckets, type BucketItem } from "./decompose.js";
import type { PeriodInfo } from "./period.js";
import { toBuckets } from "./rows.js";
import { expectedFor, slotNamesOf } from "./seasonal.js";
import type { ToolIndex } from "./toolindex.js";
import type { Bucket, ToolCaller } from "./types.js";

export interface SeasonalExpectation {
  /** The metric's value in the period (a rate, or a total). */
  value: number;
  /** What it would have been had the period followed its baseline's pattern: same weekday mix, same flags. */
  expected: number;
  /** Significance of value against expected. */
  z: number;
  /** Buckets with a comparable baseline / all buckets, so the caller can say how much was judged. */
  judged: number;
  total: number;
}

/** The finest-grained time level the headline is standardised over: the second level (a day), else none. */
export function standardisationLevel(ont: Ontology): string | null {
  return ont.time.levels[1] ?? null;
}

/** Day-level buckets of the period and of its baseline, each with its slots. */
export async function periodBuckets(tools: ToolCaller, index: ToolIndex, ont: Ontology, metric: string, info: PeriodInfo, stepId: string): Promise<{ cur: Bucket[]; base: Bucket[] } | null> {
  const level = standardisationLevel(ont);
  if (!level) return null;
  const cur = toBuckets(await tools.call(index.series(metric, level), { start: info.cur.start, end: info.cur.end }, stepId));
  const base = toBuckets(await tools.call(index.series(metric, level), { start: info.base.start, end: info.base.end }, stepId));
  return { cur, base };
}

/**
 * The seasonally expected value of a metric for the period: each day of the period is compared with
 * the baseline days at the same place in every declared cycle and with the same calendar flags, and
 * the expectation is what the period would have been at those rates (direct standardisation).
 * Returns null when seasonality is not declared or there is no finer level to standardise over, and
 * "none_comparable" when no day of the period has a comparable baseline day.
 */
export async function seasonalExpectation(
  tools: ToolCaller,
  index: ToolIndex,
  ont: Ontology,
  metric: string,
  kind: "ratio" | "sum",
  info: PeriodInfo,
  stepId: string,
): Promise<SeasonalExpectation | "none_comparable" | null> {
  const names = slotNamesOf(ont).all;
  if (names.length === 0) return null;
  const buckets = await periodBuckets(tools, index, ont, metric, info, stepId);
  if (!buckets) return null;
  const items: BucketItem[] = buckets.cur.map((b) => {
    const e = expectedFor(b, buckets.base, names);
    return { node: b.bucket, cur: { num: b.num, den: b.den, ...(b.sq !== undefined ? { sq: b.sq } : {}) }, base: e.base, matches: e.matches };
  });
  const d = decomposeBuckets(items, kind);
  if (!d) return "none_comparable";
  return {
    value: d.parent.curRate ?? 0,
    expected: d.parent.baseRate ?? 0,
    z: d.parent.z,
    judged: items.filter((i) => i.base !== null).length,
    total: items.length,
  };
}
