import { test } from "node:test";
import assert from "node:assert/strict";
import { decomposeRatio, decomposeAgainstBaseline } from "../src/decompose.js";
import { DEFAULT_THRESHOLDS, decideLevel, dominantRun, resolveThresholds } from "../src/masking.js";
import { normInv, zCritical } from "../src/stats.js";
import type { ChildRow, Direction } from "../src/types.js";

const opts = (direction: Direction = "higher_is_better", minVolume = 100) => ({ direction, minVolume, th: DEFAULT_THRESHOLDS });

/** Child with `den` rows in each window and the given baseline/current rates. */
const child = (node: string, den: number, baseRate: number, curRate: number, curDen = den): ChildRow => ({
  node,
  cur: { num: Math.round(curRate * curDen), den: curDen },
  base: { num: Math.round(baseRate * den), den },
});

test("one child collapses: drill into it with its full share", () => {
  const d = decomposeRatio([child("a", 1000, 0.95, 0.7), child("b", 1000, 0.95, 0.95), child("c", 1000, 0.95, 0.95), child("d", 1000, 0.95, 0.95)]);
  const r = decideLevel(d, opts());
  assert.equal(r.decision, "drill");
  assert.equal(r.culprit, "a");
  assert.ok(r.share! > 0.95);
  assert.deepEqual(r.flags, []);
});

test("change spread across children: broad, not drilled", () => {
  const d = decomposeRatio(["a", "b", "c", "d"].map((n) => child(n, 1000, 0.95, 0.9)));
  const r = decideLevel(d, opts());
  assert.equal(r.decision, "broad");
  assert.equal(r.culprit, null);
});

test("offsetting: one child drops while a sibling improves by the same amount", () => {
  const d = decomposeRatio([child("a", 1000, 0.95, 0.87), child("b", 1000, 0.9, 0.98), child("c", 1000, 0.92, 0.92), child("d", 1000, 0.93, 0.93)]);
  assert.ok(Math.abs(d!.parent.change) < 1e-9, "parent looks flat");
  const r = decideLevel(d, opts());
  assert.equal(r.decision, "masked");
  assert.equal(r.culprit, "a", "follows the worse sibling");
  assert.ok(r.flags.some((f) => f.type === "offsetting"));
});

test("offsetting follows the adverse direction for lower-is-better metrics", () => {
  const d = decomposeRatio([child("a", 1000, 0.05, 0.13), child("b", 1000, 0.1, 0.02)]);
  const r = decideLevel(d, opts("lower_is_better"));
  assert.equal(r.culprit, "a", "a's rate rose, which is worse");
});

test("dispersion: a flat parent hides one significantly worse child", () => {
  // child b is much worse but the other three improve just enough to hold the parent steady
  const d = decomposeRatio([child("a", 1000, 0.9, 0.9), child("b", 1000, 0.9, 0.8), child("c", 1000, 0.9, 0.9), child("d", 1000, 0.9, 0.91)]);
  const r = decideLevel(d, { ...opts(), th: { ...DEFAULT_THRESHOLDS, parent_z: 10 } });
  assert.equal(r.decision, "masked");
  assert.equal(r.culprit, "b");
  assert.ok(r.flags.some((f) => f.type === "dispersion"));
});

test("pure mix: no child got worse, volume moved to the worse child", () => {
  const d = decomposeRatio([
    { node: "x", cur: { num: 190, den: 200 }, base: { num: 760, den: 800 } },
    { node: "y", cur: { num: 640, den: 800 }, base: { num: 160, den: 200 } },
  ]);
  const r = decideLevel(d, opts());
  assert.equal(r.decision, "masked");
  assert.equal(r.effect, "mix");
  assert.equal(r.culprit, "y");
  assert.ok(r.flags.some((f) => f.type === "mix_vs_rate"));
  assert.doesNotMatch(r.flags.find((f) => f.type === "mix_vs_rate")!.detail, /Simpson/, "a pure mix shift is not Simpson's paradox");
});

test("Simpson's paradox is flagged as mix, naming the paradox", () => {
  const d = decomposeRatio([
    { node: "x", cur: { num: 184, den: 200 }, base: { num: 720, den: 800 } },
    { node: "y", cur: { num: 480, den: 800 }, base: { num: 100, den: 200 } },
  ]);
  const r = decideLevel(d, opts());
  assert.equal(r.decision, "masked");
  assert.equal(r.effect, "mix");
  assert.match(r.flags.find((f) => f.type === "mix_vs_rate")!.detail, /Simpson/);
});

test("small cells are flagged and never chosen as the culprit", () => {
  const d = decomposeRatio([child("tiny", 40, 0.96, 0.2), child("b", 1000, 0.95, 0.95), child("c", 1000, 0.95, 0.95), child("d", 1000, 0.95, 0.95)]);
  const r = decideLevel(d, opts());
  assert.notEqual(r.culprit, "tiny");
  const flag = r.flags.find((f) => f.type === "small_cells");
  assert.deepEqual(flag?.nodes, ["tiny"]);
});

test("insufficient volume stops the drill", () => {
  const d = decomposeRatio([child("a", 40, 0.9, 0.5), child("b", 40, 0.9, 0.9)]);
  assert.equal(decideLevel(d, opts()).decision, "insufficient_volume");
  assert.equal(decideLevel(null, opts()).decision, "insufficient_volume");
});

test("no change at all: broad, nothing flagged", () => {
  const d = decomposeRatio(["a", "b", "c"].map((n) => child(n, 1000, 0.93, 0.93)));
  const r = decideLevel(d, opts());
  assert.equal(r.decision, "broad");
  assert.deepEqual(r.flags, []);
});

test("a single child is reported as uninformative", () => {
  const d = decomposeRatio([child("only", 1000, 0.95, 0.8)]);
  assert.equal(decideLevel(d, opts()).informative, false);
});

test("dominantRun narrows to the contiguous buckets carrying the change", () => {
  const buckets = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ node: `t${i}`, cur: i === 2 || i === 3 ? { num: 60, den: 100 } : { num: 93, den: 100 } }));
  const d = decomposeAgainstBaseline(buckets, { num: 930, den: 1000 })!;
  const run = dominantRun(d, DEFAULT_THRESHOLDS, "higher_is_better");
  assert.deepEqual({ from: run!.from, to: run!.to }, { from: 2, to: 3 });
  assert.ok(run!.share! > 0.95);
  assert.equal(run!.masked, false);
});

test("dominantRun is null when the change is spread across the buckets", () => {
  const buckets = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ node: `t${i}`, cur: { num: 85, den: 100 } }));
  const d = decomposeAgainstBaseline(buckets, { num: 930, den: 1000 })!;
  assert.equal(dominantRun(d, DEFAULT_THRESHOLDS, "higher_is_better"), null);
});

test("dominantRun finds a significantly worse slot inside a flat-looking parent", () => {
  // one bucket at 60% among nine at 93%, but a baseline built to leave the total unremarkable
  const buckets = Array.from({ length: 10 }, (_, i) => ({ node: `t${i}`, cur: i === 4 ? { num: 60, den: 100 } : { num: 95, den: 100 } }));
  const d = decomposeAgainstBaseline(buckets, { num: 9300, den: 10000 })!;
  assert.ok(Math.abs(d.parent.z) < DEFAULT_THRESHOLDS.parent_z, "the parent looks flat");
  const run = dominantRun(d, DEFAULT_THRESHOLDS, "higher_is_better");
  assert.deepEqual({ from: run!.from, to: run!.to, masked: run!.masked, share: run!.share }, { from: 4, to: 4, masked: true, share: null });
});

test("a flat parent's slot is ignored when it is better, not worse", () => {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ node: `t${i}`, cur: i === 4 ? { num: 100, den: 100 } : { num: 84, den: 100 } }));
  const d = decomposeAgainstBaseline(buckets, { num: 8500, den: 10000 })!;
  assert.ok(Math.abs(d.parent.z) < DEFAULT_THRESHOLDS.parent_z, "the parent looks flat");
  assert.equal(dominantRun(d, DEFAULT_THRESHOLDS, "higher_is_better"), null);
  assert.ok(dominantRun(d, DEFAULT_THRESHOLDS, "lower_is_better"), "for a lower-is-better metric the same bucket is the adverse one");
});

test("zCritical raises the bar with the number of comparisons", () => {
  assert.ok(Math.abs(zCritical(1) - 2.5758) < 1e-3);
  assert.ok(zCritical(16) > zCritical(4));
  assert.ok(Math.abs(zCritical(60) - 3.77) < 0.02);
  assert.ok(Math.abs(normInv(0.975) - 1.95996) < 1e-4);
  assert.ok(Math.abs(normInv(0.001) + 3.0902) < 1e-3);
});

test("a family of many children needs stronger evidence than a family of four", () => {
  // the same moderately-significant child (z of about 3.5) is a culprit among 4 siblings but not among 60
  const make = (k: number) => decomposeRatio([child("hit", 1000, 0.95, 0.91), ...Array.from({ length: k - 1 }, (_, i) => child(`n${i}`, 1000, 0.95, 0.95))]);
  const loose = { ...opts(), th: { ...DEFAULT_THRESHOLDS, parent_z: 0.01 } };
  const four = decideLevel(make(4), loose);
  const sixty = decideLevel(make(60), loose);
  assert.equal(four.culprit, "hit");
  assert.notEqual(sixty.culprit, "hit");
});

test("resolveThresholds layers overrides over the defaults", () => {
  const t = resolveThresholds({ drill_share: 0.7 }, { child_z: 4 });
  assert.equal(t.drill_share, 0.7);
  assert.equal(t.child_z, 4);
  assert.equal(t.offset_ratio, DEFAULT_THRESHOLDS.offset_ratio);
});

test("a big child that is only a little worse than its siblings is part of a general decline, not the culprit", () => {
  // everything got worse; the large child carries most of the change by size, but its movement is not different from the rest's
  const general = decomposeRatio([child("a", 1500, 0.95, 0.8), child("b", 500, 0.95, 0.84)]);
  const r = decideLevel(general, opts());
  assert.equal(r.decision, "broad", "systemic");
  assert.equal(r.culprit, null);

  // the same size split, but now only one child fell: it stands out and is drilled
  const concentrated = decomposeRatio([child("a", 1500, 0.95, 0.8), child("b", 500, 0.95, 0.95)]);
  const c = decideLevel(concentrated, opts());
  assert.equal(c.decision, "drill");
  assert.equal(c.culprit, "a");
});
