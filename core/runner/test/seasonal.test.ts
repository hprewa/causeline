import { test } from "node:test";
import assert from "node:assert/strict";
import { decomposeAgainstBaseline, decomposeBuckets, type BucketItem } from "../src/decompose.js";
import { DEFAULT_THRESHOLDS, decideLevel, dominantRun } from "../src/masking.js";
import { constantSlots, expectedFor, slotFilterFor } from "../src/seasonal.js";
import type { Bucket } from "../src/types.js";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

/** A day bucket: weekday slot "0".."6" (Sunday = 0), optional holiday flag. */
const day = (label: string, wd: number, num: number, den: number, hol: string | null = "0", extra: Partial<Bucket> = {}): Bucket => ({
  bucket: label,
  bucket_start: `${label} 00:00:00`,
  bucket_end: `${label} 23:59:59`,
  num,
  den,
  slots: { wd: String(wd), hol },
  ...extra,
});

/** Four baseline weeks: weekdays (1..5) at 93%, Saturday (6) at 88%, Sunday (0) at 85%, with fewer calls at weekends. */
function baselineWeeks(): Bucket[] {
  const out: Bucket[] = [];
  for (let w = 0; w < 4; w++) {
    for (const [wd, den, rate] of [[1, 100, 0.93], [2, 100, 0.93], [3, 100, 0.93], [4, 100, 0.93], [5, 100, 0.93], [6, 50, 0.88], [0, 40, 0.85]] as const) {
      out.push(day(`b${w}-${wd}`, wd, Math.round(den * rate), den));
    }
  }
  return out;
}

const items = (cur: Bucket[], baseline: Bucket[]): BucketItem[] =>
  cur.map((b) => {
    const e = expectedFor(b, baseline, ["wd", "hol"]);
    return { node: b.bucket, cur: { num: b.num, den: b.den }, base: e.base, matches: e.matches };
  });

// --- like-for-like matching ---------------------------------------------------------------------

test("a bucket is compared with baseline buckets at the same place in every cycle it is constant in", () => {
  const baseline = baselineWeeks();
  const saturday = day("cur-6", 6, 44, 50);
  const e = expectedFor(saturday, baseline, ["wd", "hol"]);
  assert.equal(e.matches, 4, "four baseline Saturdays");
  assert.deepEqual(e.base, { num: 4 * 44, den: 4 * 50 });
});

test("a bucket that spans the whole cycle is compared with everything", () => {
  const week: Bucket = { bucket: "W", bucket_start: "", bucket_end: "", num: 1, den: 1, slots: { wd: null, hol: null } };
  assert.equal(expectedFor(week, baselineWeeks(), ["wd", "hol"]).matches, 28);
  assert.deepEqual(constantSlots(week, ["wd", "hol"]), {});
});

test("a holiday has no comparable baseline when the baseline has no holiday, and a normal day excludes baseline holidays", () => {
  const baseline = baselineWeeks();
  assert.equal(expectedFor(day("h", 1, 10, 50, "1"), baseline, ["wd", "hol"]).base, null, "nothing to compare a holiday with");

  const withHoliday = [...baseline, day("b-hol", 1, 3, 40, "1")];
  const monday = expectedFor(day("cur-1", 1, 93, 100), withHoliday, ["wd", "hol"]);
  assert.equal(monday.matches, 4, "the holiday Monday is not one of the comparable Mondays");
});

test("slotFilterFor keeps only the slots every bucket agrees on, as a comma list", () => {
  const run = [day("a", 3, 1, 1), day("b", 3, 1, 1)];
  assert.deepEqual(slotFilterFor(run, ["wd", "hol"]), { wd: "3", hol: "0" });
  assert.deepEqual(slotFilterFor([day("a", 3, 1, 1), day("b", 4, 1, 1)], ["wd"]), { wd: "3,4" });
  assert.deepEqual(slotFilterFor([day("a", 3, 1, 1, null), day("b", 3, 1, 1)], ["hol"]), {}, "one bucket spanning both values means no restriction");
});

// --- the property that matters ------------------------------------------------------------------

test("a week that follows its usual weekly pattern has no change and no culprit; the pooled comparison blames the weekend", () => {
  const big = (b: Bucket): Bucket => ({ ...b, num: b.num * 20, den: b.den * 20 }); // realistic volume: the contrast needs power
  const baseline = baselineWeeks().map(big);
  const cur = [
    day("c1", 1, 93, 100), day("c2", 2, 93, 100), day("c3", 3, 93, 100), day("c4", 4, 93, 100), day("c5", 5, 93, 100),
    day("c6", 6, 44, 50), day("c0", 0, 34, 40),
  ].map(big);

  const seasonal = decomposeBuckets(items(cur, baseline), "ratio")!;
  close(seasonal.parent.change, 0, 1e-9);
  assert.ok(seasonal.children.every((c) => Math.abs(c.z) < 0.5));
  assert.equal(dominantRun(seasonal, DEFAULT_THRESHOLDS, "higher_is_better"), null);

  // the old comparison: every day against one pooled rate
  const pooled = baseline.reduce((a, b) => ({ num: a.num + b.num, den: a.den + b.den }), { num: 0, den: 0 });
  const naive = decomposeAgainstBaseline(cur.map((b) => ({ node: b.bucket, cur: { num: b.num, den: b.den } })), pooled)!;
  const sunday = naive.children.find((c) => c.node === "c0")!;
  assert.ok(sunday.z < -2, `the naive comparison sees Sunday as ${sunday.z.toFixed(1)} sigma below normal`);
});

test("a genuinely bad day is still found, and the rest of the week is not blamed", () => {
  const baseline = baselineWeeks();
  const cur = [
    day("c1", 1, 93, 100), day("c2", 2, 93, 100), day("c3", 3, 60, 100), day("c4", 4, 93, 100), day("c5", 5, 93, 100),
    day("c6", 6, 44, 50), day("c0", 0, 34, 40),
  ];
  const d = decomposeBuckets(items(cur, baseline), "ratio")!;
  assert.ok(d.parent.change < -0.03);
  const run = dominantRun(d, DEFAULT_THRESHOLDS, "higher_is_better");
  assert.deepEqual({ from: run!.from, to: run!.to }, { from: 2, to: 2 });
  assert.equal(d.children.filter((c) => Math.abs(c.z) >= 3).map((c) => c.node).join(), "c3");
});

test("with one pooled baseline the per-bucket decomposition reproduces the old contributions", () => {
  const pooled = { num: 930, den: 1000 };
  const cur = [{ node: "a", cur: { num: 90, den: 100 } }, { node: "b", cur: { num: 60, den: 100 } }, { node: "c", cur: { num: 93, den: 100 } }];
  const old = decomposeAgainstBaseline(cur, pooled)!;
  const next = decomposeBuckets(cur.map((c) => ({ ...c, base: pooled, matches: 1 })), "ratio")!;
  close(next.parent.change, old.parent.change);
  next.children.forEach((c, i) => close(c.contribution, old.children[i].contribution));
  next.children.forEach((c, i) => close(c.z, old.children[i].z));
});

test("an unjudged bucket contributes nothing and does not move the parent", () => {
  const baseline = baselineWeeks();
  const cur = [day("c1", 1, 93, 100), day("hol", 2, 10, 50, "1"), day("c3", 3, 93, 100)];
  const d = decomposeBuckets(items(cur, baseline), "ratio")!;
  const hol = d.children.find((c) => c.node === "hol")!;
  assert.equal(hol.contribution, 0);
  assert.equal(hol.z, 0);
  close(d.parent.change, 0, 1e-9);
});

test("no judged bucket at all gives no decomposition", () => {
  assert.equal(decomposeBuckets(items([day("h", 1, 10, 50, "1")], baselineWeeks()), "ratio"), null);
});

// --- totals -------------------------------------------------------------------------------------

/** Daily call totals: weekdays about 100, Saturday 40, Sunday 25, with a sum of squares for variance. */
const totalsDay = (label: string, wd: number, total: number, rows: number, hol = "0"): Bucket =>
  ({ ...day(label, wd, total, rows, hol), sq: total * (total / rows) });

function baselineTotals(): Bucket[] {
  const out: Bucket[] = [];
  for (let w = 0; w < 4; w++) for (const [wd, total, rows] of [[1, 100, 100], [2, 100, 100], [3, 100, 100], [4, 100, 100], [5, 100, 100], [6, 40, 40], [0, 25, 25]] as const) out.push(totalsDay(`b${w}-${wd}`, wd, total, rows));
  return out;
}

test("totals: a quiet weekend is not a drop when the baseline weekends are quiet too", () => {
  const baseline = baselineTotals();
  const cur = [1, 2, 3, 4, 5].map((wd) => totalsDay(`c${wd}`, wd, 100, 100)).concat([totalsDay("c6", 6, 40, 40), totalsDay("c0", 0, 25, 25)]);
  const d = decomposeBuckets(items(cur, baseline), "sum")!;
  close(d.parent.change, 0);
  assert.ok(d.children.every((c) => c.contribution === 0));
});

test("totals: a surge on one afternoon's day is attributed to that day, in the metric's units", () => {
  const baseline = baselineTotals();
  const cur = [1, 2, 3, 4, 5].map((wd) => totalsDay(`c${wd}`, wd, wd === 3 ? 160 : 100, wd === 3 ? 160 : 100)).concat([totalsDay("c6", 6, 40, 40), totalsDay("c0", 0, 25, 25)]);
  const d = decomposeBuckets(items(cur, baseline), "sum")!;
  close(d.parent.change, 60);
  assert.equal(d.children.find((c) => c.node === "c3")!.contribution, 60);
  const verdict = decideLevel(d, { minVolume: 10, direction: "lower_is_better", th: { ...DEFAULT_THRESHOLDS, child_z: 2 } });
  assert.ok(Math.abs(d.children.find((c) => c.node === "c3")!.z) > 3, "significant against its own weekday's usual total");
  assert.ok(verdict.culprit === "c3" || verdict.decision !== "insufficient_volume");
});
