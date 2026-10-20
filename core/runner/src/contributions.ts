import type { Contribution } from "@causeline/schema";
import { round6, type FindingDraft, type LevelLook, type RunContext } from "./context.js";
import { toBuckets } from "./rows.js";
import { rate, sum } from "./stats.js";
import type { Bucket, Components } from "./types.js";

/** Earlier periods whose contribution a node is judged against, the fewest that make a range mean anything, and how much is looked at. */
export const HISTORY_PERIODS = 8;
export const MIN_HISTORY = 4;
/** Nodes reported (each costs one query), the share of the change a node needs to be looked at, and how many one level may offer. */
export const MAX_NODES = 5;
export const MIN_SHARE = 0.1;
const PER_LOOK = 2;
/** How many times its size a node's share of the change must be for it to stand out (a rise spread evenly over every node is nobody's). */
export const CONCENTRATION = 1.5;
/** Contributors reported for one level. */
export const PER_LEVEL = 3;

export interface Effect {
  /** The node's part of the change in the KPI, in the KPI's units; these add up exactly to the change over a full partition. */
  contribution: number;
  /** The node itself got better or worse (its rate, or for a total its change in size). */
  rate: number;
  /** Volume moved toward or away from a node with a better or worse rate than the whole. */
  mix: number;
  /** The change in the whole, in the KPI's units. */
  change: number;
}

/**
 * One node's part of the change between a period and its baseline. For a ratio this is `decomposeRatio`'s formula (rate effect
 * w1 (r1 - r0) plus mix effect (w1 - w0)(r0 - R0), a node without baseline rows taking the whole's baseline rate); for a total it is the
 * node's amount less its share of the baseline's average period. `k` is the number of baseline periods.
 */
export function effectOf(kind: "ratio" | "sum", parentCur: Components, parentBase: Components, nodeCur: Components, nodeBase: Components, k: number, thinBelow = 0): Effect {
  if (kind === "sum") {
    const change = parentCur.num - parentBase.num / k;
    const c = nodeCur.num - nodeBase.num / k;
    return { contribution: c, rate: c, mix: 0, change };
  }
  const R0 = parentBase.den > 0 ? parentBase.num / parentBase.den : 0;
  const R1 = parentCur.den > 0 ? parentCur.num / parentCur.den : 0;
  const w1 = parentCur.den > 0 ? nodeCur.den / parentCur.den : 0;
  const w0 = parentBase.den > 0 ? nodeBase.den / parentBase.den : 0;
  const r1 = rate(nodeCur);
  const r0 = rate(nodeBase) ?? R0;
  // as in decomposeRatio: the split into rate and mix uses a stable baseline rate for a thin node, the contribution the real one
  const r0Split = (nodeBase.den < thinBelow ? null : rate(nodeBase)) ?? R0;
  const rateEffect = r1 === null ? 0 : w1 * (r1 - r0Split);
  const mixEffect = (w1 - w0) * (r0Split - R0);
  return { contribution: (r1 === null ? 0 : w1 * (r1 - r0)) + (w1 - w0) * (r0 - R0), rate: rateEffect, mix: mixEffect, change: R1 - R0 };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface Verdict {
  verdict: "new" | "unusual" | "usual" | "unknown";
  typical: number | null;
  low: number | null;
  high: number | null;
  /** This period's contribution less the typical one. */
  delta: number | null;
}

/**
 * Is this period's contribution different from normal? `new`: the node was not a regular part of the data (under min_volume rows a period in
 * the baseline). `unusual`: outside everything seen in the earlier periods AND at least three robust standard deviations from their median.
 * `usual`: otherwise. `unknown`: fewer than MIN_HISTORY earlier periods to judge by.
 */
export function verdictOf(current: number, history: number[], baselineRowsPerPeriod: number, minVolume: number): Verdict {
  if (history.length === 0) return { verdict: baselineRowsPerPeriod < minVolume ? "new" : "unknown", typical: null, low: null, high: null, delta: null };
  const typical = median(history);
  const low = Math.min(...history);
  const high = Math.max(...history);
  const mad = median(history.map((h) => Math.abs(h - typical)));
  const scale = Math.max(1.4826 * mad, (high - low) / 4, 1e-12);
  const outside = current < low || current > high;
  const verdict = baselineRowsPerPeriod < minVolume ? "new" : history.length < MIN_HISTORY ? "unknown" : outside && Math.abs(current - typical) / scale >= 3 ? "unusual" : "usual";
  return { verdict, typical, low, high, delta: current - typical };
}

/** A node's day-level rows summed into the parent's periods, by the timestamps each period spans. */
export function aggregateInto(parents: Bucket[], rows: Bucket[]): Components[] {
  const out: Components[] = parents.map(() => ({ num: 0, den: 0 }));
  for (const r of rows) {
    const i = parents.findIndex((p) => r.bucket_start >= p.bucket_start && r.bucket_start <= p.bucket_end);
    if (i >= 0) out[i] = { num: out[i].num + r.num, den: out[i].den + r.den };
  }
  return out;
}

const comps = (b: Bucket): Components => ({ num: b.num, den: b.den });

/** Nodes worth reporting from what the drill looked at: the biggest contributors in the change's direction, each at least MIN_SHARE of it. */
export function candidateNodes(looks: LevelLook[]): { level: string; node: string; weight: number }[] {
  const picked = new Map<string, { level: string; node: string; weight: number }>();
  for (const look of looks) {
    const sign = Math.sign(look.decomposition.parent.change);
    if (sign === 0) continue;
    const top = look.decomposition.children
      .filter((c) => c.contribution * sign > 0 && Math.abs(c.share ?? 0) >= MIN_SHARE)
      .sort((a, b) => b.contribution * sign - a.contribution * sign)
      .slice(0, PER_LOOK);
    for (const c of top) {
      const key = `${look.concept}|${c.node}`;
      const weight = c.contribution * sign;
      if (!picked.has(key) || picked.get(key)!.weight < weight) picked.set(key, { level: look.concept, node: c.node, weight });
    }
  }
  return [...picked.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_NODES);
}

/**
 * Who contributed how much to the change, and is that usual? For the biggest contributors the drill found, each contribution (in the KPI's
 * units, as share of the change, rate and mix) is worked out for this period and for up to HISTORY_PERIODS earlier ones against their own
 * baselines, so that a node that always contributes this much is told apart from one that does not. Deterministic; adds no finding and
 * changes none. Costs one day-level query per node reported.
 */
export async function contributionsStep(ctx: RunContext, stepId: string): Promise<void> {
  const period = ctx.period;
  const series = period?.periodSeries;
  const fine = ctx.ontology.time.levels[1];
  if (!period || !series || !fine || ctx.looks.length === 0) return;
  const idx = series.findIndex((b) => b.bucket === period.label);
  if (idx < 0) return;
  const k = Math.max(1, period.baselineLabels.length);
  const baseIdx = period.baselineLabels.map((l) => series.findIndex((b) => b.bucket === l)).filter((i) => i >= 0);
  const candidates = candidateNodes(ctx.looks);
  if (candidates.length === 0) return;

  const first = Math.max(0, idx - HISTORY_PERIODS - k);
  const from = [series[first].bucket_start, period.base.start].sort()[0];
  const to = series[idx].bucket_end;
  const parentCur = comps(series[idx]);
  const parentBase = sum(baseIdx.map((i) => comps(series[i])));
  const out: Contribution[] = [];

  for (const cand of candidates) {
    const rows = toBuckets(await ctx.tools.call(ctx.index.series(ctx.metric, fine, [cand.level]), { start: from, end: to, [cand.level]: cand.node }, stepId));
    const node = aggregateInto(series, rows);
    const nodeCur = node[idx];
    const nodeBase = sum(baseIdx.map((i) => node[i]));
    const now = effectOf(ctx.kind, parentCur, parentBase, nodeCur, nodeBase, k, ctx.minVolume);
    // the same measure for each earlier period, against the periods just before it
    const history: number[] = [];
    for (let j = Math.max(k, idx - HISTORY_PERIODS); j < idx; j++) {
      const before = Array.from({ length: k }, (_, n) => j - k + n);
      history.push(effectOf(ctx.kind, comps(series[j]), sum(before.map((i) => comps(series[i]))), node[j], sum(before.map((i) => node[i])), k, ctx.minVolume).contribution);
    }
    const v = verdictOf(now.contribution, history, nodeBase.den / k, ctx.minVolume);
    out.push({
      level: cand.level,
      node: cand.node,
      contribution: round6(now.contribution) ?? 0,
      share: now.change !== 0 ? round6(now.contribution / now.change) : null,
      rate_effect: round6(now.rate),
      mix_effect: round6(now.mix),
      volume: nodeCur.den,
      baseline_volume: round6(nodeBase.den / k) ?? 0,
      baseline_share: parentBase.den > 0 ? (round6(nodeBase.den / parentBase.den) ?? 0) : 0,
      history: history.length > 0 ? { periods: history.length, typical: round6(v.typical), low: round6(v.low), high: round6(v.high) } : null,
      delta_vs_typical: round6(v.delta),
      verdict: v.verdict,
    });
  }
  ctx.contributions = out.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // how much of the change the reported nodes of one level account for: the level that accounts for the most
  const change = effectOf(ctx.kind, parentCur, parentBase, { num: 0, den: 0 }, { num: 0, den: 0 }, k).change;
  if (change !== 0) {
    const sign = Math.sign(change);
    const byLevel = new Map<string, number>();
    for (const c of out) if (c.contribution * sign > 0) byLevel.set(c.level, (byLevel.get(c.level) ?? 0) + Math.abs(c.share ?? 0));
    const best = [...byLevel.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) ctx.explained = { level: best[0], share: round6(Math.min(1, best[1])) ?? 0, unexplained: round6(Math.max(0, 1 - best[1])) ?? 0 };
  }
}


/** The concepts the findings so far already account for: a finding's own concept, and every level of the hierarchy it sits in. */
function explainedConcepts(drafts: FindingDraft[], hierarchies: Record<string, string[]>): Set<string> {
  const out = new Set<string>();
  for (const d of drafts) {
    out.add(d.dimension);
    for (const levels of Object.values(hierarchies)) if (levels.includes(d.dimension) || Object.keys(d.scope ?? {}).some((c) => levels.includes(c))) levels.forEach((l) => out.add(l));
    for (const c of Object.keys(d.scope ?? {})) out.add(c);
  }
  return out;
}

/**
 * Which contributions are worth reporting as findings when no single node dominated. A contributor is reported when the change is real,
 * the concept it belongs to has no finding yet (a drill that found a deeper node already explained its hierarchy), it carries at least
 * `minShare` of the change AND at least CONCENTRATION times its own size's share of it (so a rise spread evenly is nobody's), and it is
 * `new` or `unusual` against its own history. At most PER_LEVEL a level.
 */
export function selectContributors(contributions: Contribution[], drafts: FindingDraft[], hierarchies: Record<string, string[]>, changeIsReal: boolean, minShare: number): Contribution[] {
  if (!changeIsReal) return [];
  const taken = explainedConcepts(drafts, hierarchies);
  const perLevel = new Map<string, number>();
  const out: Contribution[] = [];
  for (const c of [...contributions].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))) {
    if (taken.has(c.level) || (c.verdict !== "new" && c.verdict !== "unusual")) continue;
    const share = c.share ?? 0;
    if (share < minShare || (c.baseline_share > 0 && share < CONCENTRATION * c.baseline_share)) continue;
    if ((perLevel.get(c.level) ?? 0) >= PER_LEVEL) continue;
    perLevel.set(c.level, (perLevel.get(c.level) ?? 0) + 1);
    out.push(c);
  }
  return out;
}

/** Report the contributors `selectContributors` picks as findings (role: contributor), so a change that no single node explains still names who carries it. */
export function contributorsStep(ctx: RunContext, stepId: string): void {
  const picked = selectContributors(ctx.contributions, ctx.drafts, ctx.ontology.hierarchies, !!ctx.headline?.significant, ctx.th.contributor_share);
  for (const c of picked) {
    ctx.drafts.push({
      dimension: c.level,
      value: c.node,
      impact: c.contribution,
      effect: Math.abs(c.mix_effect ?? 0) > Math.abs(c.rate_effect ?? 0) ? "mix" : "rate",
      role: "contributor",
      evidence: [stepId, "contributions"],
    });
  }
}
