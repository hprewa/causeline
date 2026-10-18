/** ln Gamma(x), Lanczos approximation (g = 7, n = 9), accurate to about 1e-13 for x > 0. */
export function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised upper incomplete gamma Q(a, x) = Gamma(a, x) / Gamma(a). Series below a + 1, continued fraction above. */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (!(a > 0)) throw new RangeError("a must be positive");
  const lg = lnGamma(a);
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lg));
  }
  // Lentz's continued fraction for Q
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lg) * h;
}

/** P(chi-square with df degrees of freedom >= x). */
export function chi2Survival(x: number, df: number): number {
  if (df <= 0) throw new RangeError("df must be positive");
  return gammaQ(df / 2, x / 2);
}
