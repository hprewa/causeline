import type { Thresholds } from "@causeline/schema";
import type { ChildContribution, Decomposition } from "./decompose.js";
import { zCritical } from "./stats.js";
import type { Direction } from "./types.js";

export type ResolvedThresholds = Required<Thresholds>;

export const DEFAULT_THRESHOLDS: ResolvedThresholds = {
  drill_share: 0.6,
  offset_ratio: 3,
  mix_share: 0.5,
  coverage_ratio: 0.5,
  contributor_share: 0.25,
  parent_z: 2,
  child_z: 3,
  onset_z: 2,
  // onboarding's seasonality analysis: real (p) and big enough to matter (amplitude), and seen enough times to judge
  season_p: 1e-6,
  season_amplitude: 0.03,
  season_min_repeats: 3,
};

/** Defaults, then each override layer in order (ontology, then run inputs). */
export function resolveThresholds(...layers: (Thresholds | undefined)[]): ResolvedThresholds {
  const out: ResolvedThresholds = { ...DEFAULT_THRESHOLDS };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (typeof v === "number") out[k as keyof ResolvedThresholds] = v;
    }
  }
  return out;
}

/** Share of the total change the opposite-signed rate effect must reach to be called Simpson's paradox. */
const SIMPSON_MIN = 0.15;

export type FlagType = "offsetting" | "dispersion" | "mix_vs_rate" | "small_cells";

export interface Flag {
  type: FlagType;
  detail: string;
  nodes?: string[];
}

export type DecisionKind = "drill" | "broad" | "masked" | "insufficient_volume";

export interface LevelDecision {
  decision: DecisionKind;
  /** Child to descend into, or null when the drill stops here. */
  culprit: string | null;
  effect?: "rate" | "mix";
  /** Culprit's share of the parent's change. */
  share: number | null;
  flags: Flag[];
  reason: string;
  /** False when the level has a single child, which localises nothing. */
  informative: boolean;
}

const rateVariance = (c: { num: number; den: number; sq?: number }): number => {
  if (c.den <= 0) return 0;
  const mean = c.num / c.den;
  const v = c.sq !== undefined ? Math.max(0, c.sq / c.den - mean * mean) : mean * (1 - mean);
  return v / c.den;
};

/**
 * Does the child's rate move differently from the rest of its parent? A child can carry most of a
 * change just by being big, or by being a little worse than siblings that are all worse; only a child
 * whose own movement differs from the rest's (by `minZ`) is a culprit rather than part of a general
 * decline. Rates only: a total has no rest-of-parent rate to compare. With no rest (an only child) there is
 * nothing to contrast and the child stands out by definition.
 */
function standsOut(d: Decomposition, c: ChildContribution, dir: number, minZ: number): boolean {
  if (d.kind === "sum") return true;
  const rest = (a: { num: number; den: number; sq?: number }, b: { num: number; den: number; sq?: number }) => ({
    num: a.num - b.num,
    den: a.den - b.den,
    ...(a.sq !== undefined && b.sq !== undefined ? { sq: a.sq - b.sq } : {}),
  });
  const restCur = rest(d.parent.cur, c.cur);
  const restBase = rest(d.parent.base, c.base);
  if (restCur.den <= 0 || restBase.den <= 0 || c.cur.den <= 0 || c.base.den <= 0) return true;
  const delta = (cur: { num: number; den: number }, base: { num: number; den: number }) => cur.num / cur.den - base.num / base.den;
  const se = Math.sqrt(rateVariance(c.cur) + rateVariance(c.base) + rateVariance(restCur) + rateVariance(restBase));
  if (se === 0) return true;
  return (dir * (delta(c.cur, c.base) - delta(restCur, restBase))) / se >= minZ;
}

export interface DecideOptions {
  minVolume: number;
  direction: Direction;
  th: ResolvedThresholds;
}

const adverseSign = (d: Direction) => (d === "higher_is_better" ? -1 : 1);

function argmax(items: ChildContribution[], score: (c: ChildContribution) => number): ChildContribution | null {
  let best: ChildContribution | null = null;
  let bestScore = 0;
  for (const c of items) {
    const s = score(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Decide what to do at one level of the drill: descend into a child, stop
 * (broad / insufficient volume), or descend despite a masking pattern.
 * Masking patterns, checked in this order:
 *   mix         the change is mostly volume moving between children (includes Simpson's paradox)
 *   offsetting  significant children move in opposite directions and cancel out
 *   dispersion  the parent looks flat but a child is significantly worse
 * Children whose combined current + baseline volume is below min_volume are
 * flagged and never chosen.
 */
export function decideLevel(d: Decomposition | null, opts: DecideOptions): LevelDecision {
  const { minVolume, direction, th } = opts;
  if (!d || d.parent.cur.den < minVolume) {
    return {
      decision: "insufficient_volume",
      culprit: null,
      share: null,
      flags: [],
      reason: `current volume ${d ? d.parent.cur.den : 0} is below min_volume ${minVolume}`,
      informative: false,
    };
  }

  const adv = adverseSign(direction);
  const change = d.parent.change;
  const parentSig = Math.abs(d.parent.z) >= th.parent_z;
  // A cell's rate rests on its current and baseline rows together (the z-test
  // separately guards against noise), so eligibility uses their combined volume.
  const volume = (c: ChildContribution) => c.cur.den + c.base.den;
  const small = d.children.filter((c) => volume(c) < minVolume && c.cur.den > 0);
  const eligible = d.children.filter((c) => volume(c) >= minVolume);
  // significance bar rises with the number of children being compared
  const zChild = Math.max(th.child_z, zCritical(eligible.length));
  const sig = eligible.filter((c) => Math.abs(c.z) >= zChild);
  const flags: Flag[] = [];
  const informative = d.children.length >= 2;

  if (small.length > 0) {
    flags.push({
      type: "small_cells",
      detail: `${small.length} child node(s) below min_volume ${minVolume} were not considered`,
      nodes: small.map((c) => c.node),
    });
  }

  const result = (r: Omit<LevelDecision, "flags" | "informative">): LevelDecision => ({ ...r, flags, informative });

  // mix: volume moved between children
  if (parentSig && Math.abs(d.mixTotal) > th.mix_share * Math.abs(change)) {
    const dir = Math.sign(change);
    // Simpson's paradox needs the children to have moved materially the other way, not just
    // noise with the opposite sign on top of a pure mix change.
    const simpson = Math.sign(d.rateTotal) === -dir && Math.abs(d.rateTotal) >= SIMPSON_MIN * Math.abs(change);
    flags.push({
      type: "mix_vs_rate",
      detail: simpson
        ? "children moved the opposite way to the total (Simpson's paradox): the change is volume mix, not rate"
        : `volume mix explains ${(Math.abs(d.mixTotal / change) * 100).toFixed(0)}% of the change`,
    });
    const culprit = argmax(eligible, (c) => c.mixEffect * dir);
    return result({
      decision: "masked",
      culprit: culprit?.node ?? null,
      effect: "mix",
      share: culprit ? culprit.mixEffect / change : null,
      reason: "change is mostly volume mix between children",
    });
  }

  // offsetting: significant children cancelling out
  const up = sig.filter((c) => c.contribution > 0);
  const down = sig.filter((c) => c.contribution < 0);
  if (up.length > 0 && down.length > 0) {
    const gross = sig.reduce((a, c) => a + Math.abs(c.contribution), 0);
    if (gross > th.offset_ratio * Math.abs(change)) {
      flags.push({
        type: "offsetting",
        detail: `children move ${gross.toFixed(4)} in total but the net change is ${change.toFixed(4)}`,
        nodes: sig.map((c) => c.node),
      });
      const culprit = argmax(sig, (c) => c.contribution * adv);
      return result({
        decision: "masked",
        culprit: culprit?.node ?? null,
        effect: "rate",
        share: culprit && change !== 0 ? culprit.contribution / change : null,
        reason: "children cancel each other out; following the worst one",
      });
    }
  }

  // dispersion: flat parent hiding a significantly worse child
  if (!parentSig) {
    const culprit = argmax(sig, (c) => c.rateEffect * adv);
    if (culprit) {
      flags.push({
        type: "dispersion",
        detail: `parent change is not significant (z=${d.parent.z.toFixed(1)}) but ${culprit.node} is (z=${culprit.z.toFixed(1)})`,
        nodes: [culprit.node],
      });
      return result({
        decision: "masked",
        culprit: culprit.node,
        effect: "rate",
        share: change !== 0 ? culprit.contribution / change : null,
        reason: "parent looks flat but one child is significantly worse",
      });
    }
    return result({ decision: "broad", culprit: null, share: null, reason: "no significant change at this level" });
  }

  // dominance: one child explains most of a real change
  const dir = Math.sign(change);
  const top = argmax(sig, (c) => c.contribution * dir);
  if (top && top.share !== null && top.share >= th.drill_share && standsOut(d, top, dir, th.parent_z)) {
    return result({ decision: "drill", culprit: top.node, effect: "rate", share: top.share, reason: `${top.node} explains ${(top.share * 100).toFixed(0)}% of the change` });
  }
  return result({
    decision: "broad",
    culprit: null,
    share: top?.share ?? null,
    reason: top ? `no child dominates (largest explains ${((top.share ?? 0) * 100).toFixed(0)}%): systemic` : "no significant child",
  });
}

export interface Run {
  from: number;
  to: number;
  /** Share of the parent's change the run explains; null when the parent did not change significantly. */
  share: number | null;
  /** True when the parent looked flat and the run is a significantly worse slot hiding inside it. */
  masked: boolean;
}

/**
 * Narrow time-ordered children to the contiguous run that carries the change.
 * - Parent changed: the shortest run of significantly-moved buckets that
 *   explains at least drill_share of the change.
 * - Parent looks flat: the contiguous run of significantly *worse* buckets with
 *   the largest adverse contribution (a slot hiding in a normal-looking period).
 * Returns null when nothing qualifies, or when the movement is spread across
 * more than half of the children.
 */
export function dominantRun(d: Decomposition, th: ResolvedThresholds, direction: Direction): Run | null {
  const n = d.children.length;
  const maxLen = Math.floor(n / 2);
  if (maxLen < 1) return null;
  const zChild = Math.max(th.child_z, zCritical(n));
  const change = d.parent.change;
  const parentSig = Math.abs(d.parent.z) >= th.parent_z;

  if (!parentSig) {
    const adv = adverseSign(direction);
    const bad = (i: number) => d.children[i].contribution * adv > 0 && Math.abs(d.children[i].z) >= zChild;
    let best: Run | null = null;
    let bestWeight = 0;
    for (let from = 0; from < n; ) {
      if (!bad(from)) {
        from++;
        continue;
      }
      let to = from;
      let weight = 0;
      while (to < n && bad(to)) weight += d.children[to++].contribution * adv;
      to--;
      if (to - from + 1 <= maxLen && weight > bestWeight) {
        best = { from, to, share: null, masked: true };
        bestWeight = weight;
      }
      from = to + 1;
    }
    return best;
  }

  if (change === 0) return null;
  const dir = Math.sign(change);
  // Every bucket in a run must itself be a significant move in the change's
  // direction: day-to-day noise alone can otherwise add up to a "dominant" run.
  const moved = (i: number) => d.children[i].contribution * dir > 0 && Math.abs(d.children[i].z) >= zChild;
  let best: Run | null = null;
  for (let from = 0; from < n; from++) {
    let total = 0;
    for (let to = from; to < n && to - from + 1 <= maxLen && moved(to); to++) {
      total += d.children[to].contribution;
      const share = total / change;
      if (share >= th.drill_share) {
        const len = to - from + 1;
        const bestLen = best ? best.to - best.from + 1 : Infinity;
        if (len < bestLen || (len === bestLen && share > (best?.share ?? 0))) best = { from, to, share, masked: false };
        break;
      }
    }
  }
  return best;
}
