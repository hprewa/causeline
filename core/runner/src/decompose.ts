import type { ChildRow, Components } from "./types.js";
import { rate, sum, zScore, zSum } from "./stats.js";

export interface ChildContribution {
  node: string;
  cur: Components;
  base: Components;
  curRate: number | null;
  baseRate: number | null;
  /** w1 * (r1 - r0): the child itself got better or worse. */
  rateEffect: number;
  /** (w1 - w0) * (r0 - R0): volume moved toward or away from a worse/better child. */
  mixEffect: number;
  /** The node's part of the change; contributions sum exactly to the parent's change. It equals rateEffect + mixEffect except for a node with a thin baseline, whose split uses the whole's baseline rate. */
  contribution: number;
  /** contribution / parent change, or null when the parent did not change. */
  share: number | null;
  /** Child's own rate change vs its baseline, as a z-score. */
  z: number;
}

export interface Decomposition {
  /** A decomposition of totals compares additive amounts; the default compares rates. */
  kind?: "ratio" | "sum";
  parent: { cur: Components; base: Components; curRate: number; baseRate: number; change: number; z: number };
  children: ChildContribution[];
  rateTotal: number;
  mixTotal: number;
}

/**
 * Split a ratio's change across children into rate and mix effects.
 * With shares w and rates r, and parent baseline rate R0:
 *   change = sum_i [ w1_i (r1_i - r0_i) + (w1_i - w0_i)(r0_i - R0) ]
 * A child missing from the baseline uses R0 as its baseline rate, so a new
 * child shows up as pure rate effect. So does a child whose baseline holds fewer than `thinBelow` rows: its baseline rate
 * is a handful of outcomes (0% or 100% by chance), and taking it at face value makes its rate effect and its mix effect each
 * large and opposite, which swamps the split when hundreds of such children are added up. Returns null if either window is empty.
 */
export function decomposeRatio(rows: ChildRow[], opts: { thinBelow?: number } = {}): Decomposition | null {
  const cur = sum(rows.map((r) => r.cur));
  const base = sum(rows.map((r) => r.base));
  if (cur.den <= 0 || base.den <= 0) return null;
  const R1 = cur.num / cur.den;
  const R0 = base.num / base.den;
  const change = R1 - R0;

  let rateTotal = 0;
  let mixTotal = 0;
  const children = rows.map<ChildContribution>((row) => {
    const w1 = row.cur.den / cur.den;
    const w0 = row.base.den / base.den;
    const r1 = rate(row.cur);
    const r0 = rate(row.base) ?? R0;
    // the split into rate and mix uses a stable baseline rate; the contribution itself always uses the real one, so contributions add up exactly
    const r0Split = (row.base.den < (opts.thinBelow ?? 0) ? null : rate(row.base)) ?? R0;
    const rateEffect = r1 === null ? 0 : w1 * (r1 - r0Split);
    const mixEffect = (w1 - w0) * (r0Split - R0);
    rateTotal += rateEffect;
    mixTotal += mixEffect;
    const contribution = (r1 === null ? 0 : w1 * (r1 - r0)) + (w1 - w0) * (r0 - R0);
    return {
      node: row.node,
      cur: row.cur,
      base: row.base,
      curRate: r1,
      baseRate: rate(row.base),
      rateEffect,
      mixEffect,
      contribution,
      share: change === 0 ? null : contribution / change,
      z: zScore(row.cur, row.base),
    };
  });

  return {
    parent: { cur, base, curRate: R1, baseRate: R0, change, z: zScore(cur, base) },
    children,
    rateTotal,
    mixTotal,
  };
}

/**
 * Decompose against a single pooled baseline (used for time buckets, where
 * each bucket has no baseline of its own). There is no mix effect: every
 * bucket's baseline rate is the pooled baseline rate.
 */
export function decomposeAgainstBaseline(buckets: { node: string; cur: Components }[], base: Components): Decomposition | null {
  const cur = sum(buckets.map((b) => b.cur));
  if (cur.den <= 0 || base.den <= 0) return null;
  const R1 = cur.num / cur.den;
  const R0 = base.num / base.den;
  const change = R1 - R0;
  let rateTotal = 0;
  const children = buckets.map<ChildContribution>((b) => {
    const r1 = rate(b.cur);
    const rateEffect = r1 === null ? 0 : (b.cur.den / cur.den) * (r1 - R0);
    rateTotal += rateEffect;
    return {
      node: b.node,
      cur: b.cur,
      base,
      curRate: r1,
      baseRate: R0,
      rateEffect,
      mixEffect: 0,
      contribution: rateEffect,
      share: change === 0 ? null : rateEffect / change,
      z: zScore(b.cur, base),
    };
  });
  return {
    parent: { cur, base, curRate: R1, baseRate: R0, change, z: zScore(cur, base) },
    children,
    rateTotal,
    mixTotal: 0,
  };
}

/**
 * Split the change of a total across children. Each child's contribution is its own total minus
 * what the baseline predicts for it (`scale` times its baseline total), so contributions add up to
 * the parent's change exactly. Totals have no mix effect: every child contributes through its own
 * movement. The shared Decomposition shape is reused, with `curRate` holding the current total and
 * `baseRate` the expected one, so masking and decisions need no changes.
 */
export function decomposeSum(rows: ChildRow[], scale: number): Decomposition | null {
  const cur = sum(rows.map((r) => r.cur));
  const base = sum(rows.map((r) => r.base));
  if (cur.den <= 0 || base.den <= 0) return null;
  const expected = scale * base.num;
  const change = cur.num - expected;

  const children = rows.map<ChildContribution>((row) => {
    const exp = scale * row.base.num;
    const contribution = row.cur.num - exp;
    return {
      node: row.node,
      cur: row.cur,
      base: row.base,
      curRate: row.cur.num,
      baseRate: exp,
      rateEffect: contribution,
      mixEffect: 0,
      contribution,
      share: change === 0 ? null : contribution / change,
      z: zSum(row.cur, row.base, scale),
    };
  });
  return {
    parent: { cur, base, curRate: cur.num, baseRate: expected, change, z: zSum(cur, base, scale) },
    children,
    rateTotal: change,
    mixTotal: 0,
    kind: "sum",
  };
}

/** One bucket with its own like-for-like baseline. `base` is null when nothing comparable exists. */
export interface BucketItem {
  node: string;
  cur: Components;
  base: Components | null;
  /** How many baseline buckets `base` pools (scales a total's expectation to one bucket). */
  matches: number;
}

const variance = (c: Components, mean: number) => (c.sq !== undefined && c.den > 0 ? Math.max(0, c.sq / c.den - mean * mean) : mean * (1 - mean));

/**
 * Decompose the change across buckets that each have their own expectation (the same weekday in the
 * baseline, the same hour). A bucket with no comparable baseline is not judged: it contributes
 * nothing and says nothing, rather than being compared with something unlike it. With a single
 * pooled baseline this reduces to decomposeAgainstBaseline / decomposeSum.
 *
 * Ratio: contribution = w * (rate - expected rate); the parent's expectation is the rate the period
 * would have had at its own mix of buckets. Total: contribution = total - (baseline total / matches).
 * Same Decomposition shape as the others, so masking and decisions are unchanged.
 */
export function decomposeBuckets(items: BucketItem[], kind: "ratio" | "sum"): Decomposition | null {
  const cur = sum(items.map((i) => i.cur));
  const judged = items.filter((i) => i.base !== null && i.base.den > 0);
  if (cur.den <= 0 || judged.length === 0) return null;
  const base = sum(judged.map((i) => i.base!));

  if (kind === "sum") {
    let change = 0;
    let varSum = 0;
    const children = items.map<ChildContribution>((i) => {
      const ok = i.base !== null && i.base.den > 0;
      const expected = ok ? i.base!.num / i.matches : i.cur.num;
      const contribution = ok ? i.cur.num - expected : 0;
      change += contribution;
      if (ok) varSum += (i.cur.sq ?? 0) + (i.base!.sq ?? 0) / (i.matches * i.matches);
      return {
        node: i.node,
        cur: i.cur,
        base: i.base ?? { num: 0, den: 0 },
        curRate: i.cur.num,
        baseRate: expected,
        rateEffect: contribution,
        mixEffect: 0,
        contribution,
        share: null,
        z: ok ? zSum(i.cur, i.base!, 1 / i.matches) : 0,
      };
    });
    const expectedTotal = cur.num - change;
    for (const c of children) c.share = change === 0 ? null : c.contribution / change;
    const se = Math.sqrt(varSum);
    return {
      parent: { cur, base, curRate: cur.num, baseRate: expectedTotal, change, z: se === 0 ? (change === 0 ? 0 : Math.sign(change) * Infinity) : change / se },
      children,
      rateTotal: change,
      mixTotal: 0,
      kind: "sum",
    };
  }

  const W = cur.den;
  const R1 = cur.num / W;
  let change = 0;
  let varDiff = 0;
  const children = items.map<ChildContribution>((i) => {
    const w = i.cur.den / W;
    const r1 = rate(i.cur);
    const ok = i.base !== null && i.base.den > 0 && r1 !== null;
    const r0 = ok ? i.base!.num / i.base!.den : r1;
    const contribution = ok ? w * (r1! - r0!) : 0;
    change += contribution;
    if (ok) varDiff += w * w * (variance(i.cur, r1!) / i.cur.den + variance(i.base!, r0!) / i.base!.den);
    return {
      node: i.node,
      cur: i.cur,
      base: i.base ?? { num: 0, den: 0 },
      curRate: r1,
      baseRate: ok ? r0 : null,
      rateEffect: contribution,
      mixEffect: 0,
      contribution,
      share: null,
      z: ok ? zScore(i.cur, i.base!) : 0,
    };
  });
  for (const c of children) c.share = change === 0 ? null : c.contribution / change;
  const se = Math.sqrt(varDiff);
  return {
    parent: { cur, base, curRate: R1, baseRate: R1 - change, change, z: se === 0 ? (change === 0 ? 0 : Math.sign(change) * Infinity) : change / se },
    children,
    rateTotal: change,
    mixTotal: 0,
  };
}
