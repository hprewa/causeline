import type { Bucket, Components } from "./types.js";
import { zScore, zSum } from "./stats.js";

/**
 * How much more a metric moves from one period to the next than counting noise alone would give. The z-scores of children assume
 * counting noise only (a binomial rate, a compound-Poisson total), which is right for a sample of independent rows and far too
 * confident for data whose weekly volume or rate has a life of its own: an ordinary week then looks like a significant change in
 * half the nodes. The excess is estimated from the whole's own history and added to every child's variance.
 */
export interface Dispersion {
  /** For a rate: the extra variance of a period's rate as a multiple of p(1 - p) (the intra-period correlation). */
  rho: number;
  /** For a total: the extra variance of a period's total as a multiple of its mean squared (the squared relative noise). */
  s2: number;
  /** The same relative noise for a count of rows, for the data-quality check. */
  volumeS2: number;
  /** Earlier periods it was estimated from (0 when there were too few, and then nothing is adjusted). */
  history: number;
}

export const NO_DISPERSION: Dispersion = { rho: 0, s2: 0, volumeS2: 0, history: 0 };

/** Earlier periods looked at, and the fewest that make an estimate of spread mean anything. */
export const DISPERSION_PERIODS = 12;
export const MIN_DISPERSION_PERIODS = 5;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]) => {
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};

/**
 * Estimate the extra, non-counting variation of a metric from the periods before the one being analysed (`idx` in `series`): for a total, the
 * relative variance of the period totals beyond what the rows' own values give; for a rate, the variance of the period rates beyond
 * binomial. Never negative; zero with fewer than MIN_DISPERSION_PERIODS earlier periods.
 */
export function estimateDispersion(series: Bucket[], idx: number, kind: "ratio" | "sum"): Dispersion {
  const past = series.slice(Math.max(0, idx - DISPERSION_PERIODS), idx).filter((b) => b.den > 0);
  if (past.length < MIN_DISPERSION_PERIODS) return NO_DISPERSION;
  const dens = past.map((b) => b.den);
  const meanDen = mean(dens);
  const volumeS2 = meanDen > 0 ? Math.max(0, (variance(dens) - meanDen) / (meanDen * meanDen)) : 0;
  if (kind === "sum") {
    const totals = past.map((b) => b.num);
    const m = mean(totals);
    if (m <= 0) return { ...NO_DISPERSION, volumeS2, history: past.length };
    const counting = mean(past.map((b) => b.sq ?? b.num));
    return { rho: 0, s2: Math.max(0, (variance(totals) - counting) / (m * m)), volumeS2, history: past.length };
  }
  const rates = past.map((b) => b.num / b.den);
  const pooled = past.reduce((a, b) => a + b.num, 0) / past.reduce((a, b) => a + b.den, 0);
  const pq = pooled * (1 - pooled);
  if (pq <= 0) return { ...NO_DISPERSION, volumeS2, history: past.length };
  const counting = mean(past.map((b) => (b.sq !== undefined ? Math.max(0, b.sq / b.den - (b.num / b.den) ** 2) : pq) / b.den));
  return { rho: Math.max(0, (variance(rates) - counting) / pq), s2: 0, volumeS2, history: past.length };
}

/**
 * A child's z-score with the extra variation added: the rate's variance gains rho p (1 - p) for the period and a `1 / periods` share of it for the
 * baseline's average; a total's gains s2 m^2 in the same way (m is the baseline's expected total, k scales the baseline to the period).
 * With no dispersion this is exactly zScore / zSum.
 */
export function adjustedZ(kind: "ratio" | "sum", cur: Components, base: Components, k: number, disp: Dispersion): number {
  if (kind === "sum") {
    const plain = zSum(cur, base, k);
    if (disp.s2 <= 0 || !Number.isFinite(plain)) return plain;
    const diff = cur.num - k * base.num;
    const m = k * base.num;
    const se2 = (cur.sq ?? 0) + k * k * (base.sq ?? 0) + disp.s2 * m * m * (1 + k);
    return se2 > 0 ? diff / Math.sqrt(se2) : plain;
  }
  const plain = zScore(cur, base);
  if (disp.rho <= 0 || !Number.isFinite(plain) || cur.den <= 0 || base.den <= 0) return plain;
  const diff = cur.num / cur.den - base.num / base.den;
  const n = cur.den + base.den;
  const pooled = (cur.num + base.num) / n;
  const variance0 = cur.sq !== undefined && base.sq !== undefined ? Math.max(0, (cur.sq + base.sq) / n - pooled * pooled) : pooled * (1 - pooled);
  const periods = 1 / Math.max(k, 1e-9);
  const se2 = variance0 * (1 / cur.den + 1 / base.den) + disp.rho * pooled * (1 - pooled) * (1 + 1 / periods);
  return se2 > 0 ? diff / Math.sqrt(se2) : plain;
}

/**
 * Is a node's shortfall in rows more than the data's own variation explains? Counting noise is the square root of the usual count; the
 * period-to-period noise beyond it is `volumeS2` times the usual count squared.
 */
export function shortfallZ(usual: number, current: number, disp: Dispersion): number {
  const sd = Math.sqrt(usual + disp.volumeS2 * usual * usual);
  return sd > 0 ? (usual - current) / sd : 0;
}

/**
 * A z-score from the seasonal standardisation (the headline of a KPI with declared cycles), with the data's own period-to-period movement added
 * to its standard error the way `adjustedZ` does for the plain form. `value` and `expected` are in the units of the KPI (a rate, or a period
 * total); `k` scales a total's baseline to the period and `periods` is how many baseline periods the rate's expectation averages. With no
 * dispersion the z comes back unchanged.
 */
export function inflateZ(kind: "ratio" | "sum", z: number, value: number, expected: number, k: number, periods: number, disp: Dispersion): number {
  if (!Number.isFinite(z) || z === 0) return z;
  const extra = kind === "sum" ? disp.s2 * expected * expected * (1 + k) : disp.rho * expected * (1 - expected) * (1 + 1 / Math.max(1, periods));
  if (!(extra > 0)) return z;
  const diff = value - expected;
  const se2 = (diff / z) ** 2;
  return diff / Math.sqrt(se2 + extra);
}

/** Fewest leave-one-out comparisons that make an estimate of a bucket level's own spread mean anything. */
export const MIN_BUCKET_RESIDUALS = 8;

/**
 * The extra, non-counting variation of the buckets of one time level (the days of a week, the half hours of a day), estimated from the baseline
 * buckets themselves: each is compared with the other baseline buckets at the same place in the cycles (`expectedOf`), and what is left beyond
 * the counting noise of that comparison is the level's own spread. A day's total moves far more than a week's total does, so the week's spread
 * cannot judge it. Zero (nothing adjusted) with fewer than MIN_BUCKET_RESIDUALS comparisons.
 */
export function bucketDispersion(baseline: Bucket[], expectedOf: (b: Bucket, others: Bucket[]) => { base: Components | null; matches: number }, kind: "ratio" | "sum"): Dispersion {
  const resid: number[] = [];
  const counting: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i];
    if (b.den <= 0) continue;
    const e = expectedOf(b, baseline.filter((_, j) => j !== i));
    if (!e.base || e.base.den <= 0 || e.matches < 1) continue;
    const k = 1 / e.matches;
    if (kind === "sum") {
      const expected = e.base.num * k;
      if (expected <= 0) continue;
      resid.push(((b.num - expected) / expected) ** 2);
      counting.push(((b.sq ?? b.num) + (e.base.sq ?? e.base.num) * k * k) / (expected * expected));
    } else {
      const pooled = (b.num + e.base.num) / (b.den + e.base.den);
      const pq = pooled * (1 - pooled);
      if (pq <= 0) continue;
      resid.push((b.num / b.den - e.base.num / e.base.den) ** 2 / pq);
      counting.push(1 / b.den + 1 / e.base.den);
    }
    weight.push(1 + k);
  }
  if (resid.length < MIN_BUCKET_RESIDUALS) return NO_DISPERSION;
  const excess = Math.max(0, mean(resid.map((r, i) => (r - counting[i]) / weight[i])));
  return kind === "sum" ? { rho: 0, s2: excess, volumeS2: 0, history: resid.length } : { rho: excess, s2: 0, volumeS2: 0, history: resid.length };
}
