import type { RunContext } from "./context.js";
import { NO_DISPERSION, type Dispersion } from "./dispersion.js";
import { toChildRows } from "./rows.js";
import type { Bucket, ChildRow, Components } from "./types.js";

/**
 * The spread each part of a level is judged by.
 *
 * A part (one of the children a level splits into) moves from one period to the next by more than counting noise, and by more than the whole it
 * belongs to: twelve parts that each wobble on their own make a whole that wobbles far less than any one of them. Judging a part by the whole's
 * spread therefore treats ordinary movement of a part as significant. Here every part gets its own.
 *
 * The estimator, for one level (the children one query returns):
 *   1. The level is read for earlier periods like this one (same calendar flags), up to SPREAD_PERIODS of them: in one query when the pack
 *      has a history tool, else with the same query two periods a call. Both give the same numbers (see `pairsFromHistory`).
 *   2. For each child, the excess of its period-to-period variance over counting noise is worked out exactly as for the whole
 *      (`estimateDispersion`): for a rate as a multiple of p(1 - p), for a total as a multiple of its mean squared. It is left unfloored here,
 *      so that averaging does not bias it upward.
 *   3. The level's typical excess is the average of the children's, weighted by how many periods each rests on.
 *   4. A child's excess is its own pulled toward the level's: (own x own periods + level x PRIOR_PERIODS) / (own periods + PRIOR_PERIODS),
 *      a simple empirical-Bayes shrink. A handful of periods says little about one child's variance (five quiet weeks understate it badly),
 *      while the siblings together say a lot about what is usual at this level. The result is never below zero: counting noise is the floor.
 *
 * With fewer than MIN_SPREAD_PERIODS earlier periods there is no estimate, and the caller keeps what it did before (the whole's spread).
 */
export const SPREAD_PERIODS = 12;
export const MIN_SPREAD_PERIODS = 3;
/** How many periods of a child's own history the level's typical spread counts for. */
export const PRIOR_PERIODS = 12;

export interface LevelSpread {
  /** The spread to judge a child by; a child with no history of its own gets the level's. */
  of(node: string): Dispersion;
  /** The level's typical excess (a rate's rho or a total's s2). */
  level: number;
  /** Earlier periods looked at. */
  periods: number;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]) => {
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};

/** One child's excess variance over counting noise, unfloored, and the periods it rests on (null with fewer than MIN_SPREAD_PERIODS). */
export function rawExcess(series: Components[], kind: "ratio" | "sum"): { excess: number; periods: number } | null {
  if (kind === "sum") {
    // a period with no rows is a real zero for a total
    if (series.length < MIN_SPREAD_PERIODS) return null;
    const totals = series.map((b) => b.num);
    const m = mean(totals);
    if (!(m > 0)) return null;
    const counting = mean(series.map((b) => b.sq ?? b.num));
    return { excess: (variance(totals) - counting) / (m * m), periods: series.length };
  }
  const past = series.filter((b) => b.den > 0);
  if (past.length < MIN_SPREAD_PERIODS) return null;
  const pooled = past.reduce((a, b) => a + b.num, 0) / past.reduce((a, b) => a + b.den, 0);
  const pq = pooled * (1 - pooled);
  if (!(pq > 0)) return null;
  const counting = mean(past.map((b) => (b.sq !== undefined ? Math.max(0, b.sq / b.den - (b.num / b.den) ** 2) : pq) / b.den));
  return { excess: (variance(past.map((b) => b.num / b.den)) - counting) / pq, periods: past.length };
}

/** Steps 3 and 4 of the estimator: from each child's history to the spread it is judged by. */
export function shrinkSpreads(history: Map<string, Components[]>, kind: "ratio" | "sum", periods: number): LevelSpread | null {
  const raw = new Map<string, { excess: number; periods: number }>();
  for (const [node, series] of history) {
    const r = rawExcess(series, kind);
    if (r) raw.set(node, r);
  }
  if (raw.size === 0) return null;
  let weight = 0;
  let sum = 0;
  for (const r of raw.values()) {
    weight += r.periods - 1;
    sum += (r.periods - 1) * r.excess;
  }
  const level = Math.max(0, sum / weight);
  const as = (x: number): Dispersion => (kind === "sum" ? { ...NO_DISPERSION, s2: x, history: periods } : { ...NO_DISPERSION, rho: x, history: periods });
  return {
    level,
    periods,
    of(node) {
      const r = raw.get(node);
      if (!r) return as(level);
      const own = r.periods - 1;
      return as(Math.max(0, (own * r.excess + PRIOR_PERIODS * level) / (own + PRIOR_PERIODS)));
    },
  };
}

/** The earlier periods a level's spread is estimated from: before the period, with its calendar flags, newest first. */
export function spreadPeriods(ctx: RunContext): Bucket[] {
  const series = ctx.period?.periodSeries ?? [];
  const at = series.findIndex((b) => b.bucket === ctx.period?.label);
  if (at <= 0) return [];
  const signature = (b: Bucket) => ctx.slots.calendar.map((c) => b.slots?.[c] ?? "~").join("|");
  const own = signature(series[at]);
  return series
    .slice(0, at)
    .filter((b) => signature(b) === own && b.den > 0)
    .slice(-SPREAD_PERIODS)
    .reverse();
}

/**
 * From the rows of a history query (node, bucket, num, den, sq), what the slice query would have returned for two periods: every node with
 * rows in either, and zeros for the period it is absent from. Kept in that shape so both ways of reading the history give identical numbers.
 */
export function pairsFromHistory(rows: Record<string, unknown>[], a: string, b: string): ChildRow[] {
  const zero = (): Components => ({ num: 0, den: 0, sq: 0 });
  const out = new Map<string, ChildRow>();
  for (const r of rows) {
    const bucket = String(r.bucket);
    if (bucket !== a && bucket !== b) continue;
    const node = String(r.node);
    const row = out.get(node) ?? { node, cur: zero(), base: zero() };
    const c = { num: Number(r.num ?? 0), den: Number(r.den ?? 0), sq: Number(r.sq ?? 0) };
    if (bucket === a) row.cur = c;
    if (bucket === b) row.base = c;
    out.set(node, row);
  }
  return [...out.values()];
}

/**
 * The spread of the children a slice query returns, from the same query asked for earlier periods. `params` are the query's own (its filters and
 * calendar restrictions carry over; the windows and any narrowing to a slot of a cycle are replaced by whole earlier periods). Kept for the
 * run, so a level looked at twice is asked once.
 */
export async function levelSpread(ctx: RunContext, tool: string, params: Record<string, string>, stepId: string): Promise<LevelSpread | null> {
  const periods = spreadPeriods(ctx);
  if (periods.length < MIN_SPREAD_PERIODS) return null;
  const calendar = new Set(ctx.slots.calendar);
  const filters = Object.fromEntries(
    Object.entries(params)
      .filter(([k]) => !["cur_start", "cur_end", "base_start", "base_end"].includes(k))
      .map(([k, v]) => [k, k.startsWith("s_") && !calendar.has(k.slice(2)) ? "" : v]),
  );
  const key = `${tool}|${JSON.stringify(filters)}`;
  ctx.spreads ??= new Map();
  const kept = ctx.spreads.get(key);
  if (kept !== undefined) return kept;

  const history = new Map<string, Components[]>();
  const add = (node: string, c: Components) => history.set(node, [...(history.get(node) ?? []), c]);
  // one query for every period when the pack can answer it and the periods are whole buckets of one time level
  const concepts = Object.keys(filters).filter((k) => !k.startsWith("s_") && filters[k] !== "");
  const oneQuery = ctx.period?.periodLevel && process.env.CAUSELINE_HISTORY_BY_PAIRS !== "1" ? ctx.index.historyFor(tool, ctx.period.periodLevel, concepts) : undefined;
  const all = oneQuery ? await ctx.tools.call(oneQuery, { ...filters, start: periods[periods.length - 1].bucket_start, end: periods[0].bucket_end }, stepId) : undefined;
  for (let i = 0; i < periods.length; i += 2) {
    const a = periods[i];
    const b = periods[i + 1] ?? a;
    const rows = all
      ? pairsFromHistory(all, a.bucket, b.bucket)
      : toChildRows(await ctx.tools.call(tool, { ...filters, cur_start: a.bucket_start, cur_end: a.bucket_end, base_start: b.bucket_start, base_end: b.bucket_end }, stepId));
    for (const r of rows) {
      add(r.node, r.cur);
      if (b !== a) add(r.node, r.base);
    }
  }
  if (ctx.kind === "sum") {
    // a child absent from a period's rows had none: a real zero for a total
    for (const [node, series] of history) if (series.length < periods.length) history.set(node, [...series, ...Array<Components>(periods.length - series.length).fill({ num: 0, den: 0, sq: 0 })]);
  }
  const spread = shrinkSpreads(history, ctx.kind, periods.length);
  ctx.spreads.set(key, spread);
  return spread;
}
