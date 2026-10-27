import type { Components } from "./types.js";

/** Rate of a components pair, or null when the denominator is empty. */
export function rate(c: Components): number | null {
  return c.den > 0 ? c.num / c.den : null;
}

export function add(a: Components, b: Components): Components {
  return addComponents(a, b);
}

export function sum(items: Components[]): Components {
  return items.length === 0 ? { num: 0, den: 0 } : items.reduce(add);
}

/**
 * z-score of a ratio in cur vs base, with the variance pooled over both samples. With the sum of
 * squared numerators (`sq`) the pooled variance is sq/n - mean^2, which for a 0/1 numerator is
 * exactly the binomial p(1-p), and for anything else (a handle time, a cost per item) is the real
 * variance of the numerator. Without `sq` it falls back to the binomial form. Treats the denominator
 * as the sample size, which is exact when it counts rows. Returns 0 when either side is empty.
 */
export function zScore(cur: Components, base: Components): number {
  if (cur.den <= 0 || base.den <= 0) return 0;
  const diff = cur.num / cur.den - base.num / base.den;
  const n = cur.den + base.den;
  const pooled = (cur.num + base.num) / n;
  const variance = cur.sq !== undefined && base.sq !== undefined ? Math.max(0, (cur.sq + base.sq) / n - pooled * pooled) : pooled * (1 - pooled);
  const se = Math.sqrt(variance * (1 / cur.den + 1 / base.den));
  if (se === 0) return diff === 0 ? 0 : Math.sign(diff) * Infinity;
  return diff / se;
}

/** Sum two components, keeping the sum of squares when both have one. */
export function addComponents(a: Components, b: Components): Components {
  return { num: a.num + b.num, den: a.den + b.den, ...(a.sq !== undefined && b.sq !== undefined ? { sq: a.sq + b.sq } : {}) };
}

/**
 * z-score of a current total against `k` times a baseline total, where k scales the baseline to
 * the current window's length (for example 1/4 when the baseline is four periods). A total is a
 * sum over a varying number of rows, so its variance is about the sum of the squared row values
 * (compound Poisson): se = sqrt(cur.sq + k^2 * base.sq).
 */
export function zSum(cur: Components, base: Components, k: number): number {
  const diff = cur.num - k * base.num;
  const se = Math.sqrt((cur.sq ?? 0) + k * k * (base.sq ?? 0));
  if (se === 0) return diff === 0 ? 0 : Math.sign(diff) * Infinity;
  return diff / se;
}

/** Inverse of the standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError("p must be in (0, 1)");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Two-sided critical z for a family of k comparisons at overall level alpha
 * (Bonferroni). Scanning many children at a fixed z flags noise more often the
 * more children there are; this raises the bar with the family size.
 */
export function zCritical(k: number, alpha = 0.01): number {
  const family = Math.max(1, k);
  return normInv(1 - alpha / family / 2);
}

/** ln of the gamma function (Lanczos). */
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** The regularised incomplete beta function I_x(a, b) (continued fraction). */
function betai(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const frac = (xx: number, aa: number, bb: number): number => {
    const tiny = 1e-30;
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aaN = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + aaN * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aaN / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      aaN = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + aaN * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aaN / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 3e-16) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? (front * frac(x, a, b)) / a : 1 - (front * frac(1 - x, b, a)) / b;
}

/** P(T <= t) for Student's t with df degrees of freedom. */
export function tCdf(t: number, df: number): number {
  const tail = 0.5 * betai(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/**
 * Quantile of Student's t: the t with P(T <= t) = p. With an estimated spread the test statistic is not normal: a spread learned from n periods
 * makes the tails heavier by an amount that shrinks as n grows. With no degrees of freedom to speak of (df not finite) it is the normal quantile.
 */
export function tInv(p: number, df: number): number {
  if (p <= 0 || p >= 1) throw new RangeError("p must be in (0, 1)");
  if (!Number.isFinite(df) || df > 1e6) return normInv(p);
  if (p === 0.5) return 0;
  if (p < 0.5) return -tInv(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p && hi < 1e9) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12 * Math.max(1, hi)) break;
  }
  return (lo + hi) / 2;
}
