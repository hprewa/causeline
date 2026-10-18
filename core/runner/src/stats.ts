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
