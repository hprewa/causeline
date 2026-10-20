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
