import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import { decomposeSum } from "../src/decompose.js";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { zScore, zSum } from "../src/stats.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const playbook = loadPlaybook("metric_change", "no-such-pack");

async function run(metric: string, faults: FaultSpec[], period = "W5") {
  const result = await runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(faults)), inputs: { metric, period } });
  assert.doesNotThrow(() => Result.parse(result));
  return result;
}

const inP2Week5 = (f: { week: number; a2: string }) => f.week === 5 && f.a2 === "P2";

// --- the maths ---------------------------------------------------------------------------------

test("sum: contributions add up exactly to the change against the scaled baseline", () => {
  const d = decomposeSum(
    [
      { node: "a", cur: { num: 120, den: 12, sq: 1300 }, base: { num: 400, den: 40, sq: 4200 } },
      { node: "b", cur: { num: 90, den: 9, sq: 950 }, base: { num: 400, den: 40, sq: 4100 } },
      { node: "c", cur: { num: 100, den: 10, sq: 1050 }, base: { num: 400, den: 40, sq: 4100 } },
    ],
    0.25,
  )!;
  close(d.parent.change, 310 - 300);
  close(d.children.map((c) => c.contribution).reduce((s, x) => s + x, 0), d.parent.change);
  assert.deepEqual(d.children.map((c) => c.contribution), [20, -10, 0]);
  assert.equal(d.mixTotal, 0, "a total has no mix effect");
  close(d.children[0].share!, 2);
});

test("sum: returns null when a window is empty", () => {
  assert.equal(decomposeSum([{ node: "a", cur: { num: 0, den: 0 }, base: { num: 5, den: 1 } }], 0.25), null);
});

test("zSum: variance of a total is about the sum of squared row values", () => {
  const z = zSum({ num: 120, den: 12, sq: 1200 }, { num: 400, den: 40, sq: 4000 }, 0.25);
  close(z, 20 / Math.sqrt(1200 + 0.0625 * 4000));
  assert.equal(zSum({ num: 5, den: 1, sq: 0 }, { num: 0, den: 0, sq: 0 }, 0.25), Infinity);
  assert.equal(zSum({ num: 0, den: 0, sq: 0 }, { num: 0, den: 0, sq: 0 }, 0.25), 0);
});

test("zScore: with sums of squares, a 0/1 numerator gives exactly the binomial answer", () => {
  const cur = { num: 90, den: 100 };
  const base = { num: 380, den: 400 };
  close(zScore({ ...cur, sq: 90 }, { ...base, sq: 380 }), zScore(cur, base)); // x*x = x for 0/1
});

test("zScore: a non-binary numerator (a handle time) gets its real variance, not p(1-p)", () => {
  // 100 calls averaging 310s against 400 calls averaging 300s, each with a standard deviation of 20s
  const mk = (n: number, mean: number, sd: number) => ({ num: n * mean, den: n, sq: n * (sd * sd + mean * mean) });
  const z = zScore(mk(100, 310, 20), mk(400, 300, 20));
  assert.ok(Number.isFinite(z), "the binomial formula would give NaN here");
  // 10 / sqrt(pooled variance * (1/100 + 1/400)); the pooled variance includes the spread between the means
  assert.ok(z > 4.2 && z < 4.6, `z was ${z}`);
});

// --- sum metrics, end to end -------------------------------------------------------------------

test("sum: a group whose amounts triple is found, in the metric's own units", async () => {
  const r = await run("total_amount", [{ where: inP2Week5, okOutOf10: 9, amountFactor: 3 }]);
  assert.equal(r.status, "complete");
  assert.equal(r.headline!.kind, "sum");
  assert.ok(r.headline!.change > 5000, "the total rose by thousands of units, not a fraction");
  assert.equal(r.findings[0].dimension, "a2");
  assert.equal(r.findings[0].value, "P2");
  assert.equal(r.findings[0].metric, "total_amount");
  assert.equal(r.findings[0].effect, "rate");
  assert.ok(r.findings[0].impact > 5000);
  assert.equal(r.findings[0].persistence, undefined, "no slot-by-slot persistence for totals");
});

test("sum: time localisation inside the period is not applied, and the path says so", async () => {
  const r = await run("total_amount", [{ where: inP2Week5, okOutOf10: 9, amountFactor: 3 }]);
  const time = r.path.find((p) => p.hierarchy === "time")!;
  assert.equal(time.node, "(not applied)");
  assert.match(String(time.numbers.reason), /additive metrics/);
  assert.ok(!r.steps.some((s) => s.tool.startsWith("total_amount_by_dy")), "no day-level queries");
});

test("sum: a count metric finds the group with extra volume", async () => {
  const r = await run("n_rows", [{ where: inP2Week5, okOutOf10: 9, extraOutOf10: 5 }]);
  assert.equal(r.findings[0].value, "P2");
  assert.equal(r.findings[0].metric, "n_rows");
  assert.ok(r.headline!.change > 100);
});

test("sum: clean data reports nothing and raises no flags", async () => {
  for (const metric of ["total_amount", "n_rows"]) {
    const r = await run(metric, []);
    assert.deepEqual(r.findings, [], metric);
    assert.deepEqual(r.masking_flags, [], metric);
    assert.ok(Math.abs(r.headline!.change) < 1e-6, metric);
  }
});

test("sum: an offset (one group up, a sibling down by the same total) is flagged like any other", async () => {
  const r = await run("total_amount", [
    { where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 9, amountFactor: 2 },
    { where: (f) => f.week === 5 && f.a2 === "P1", okOutOf10: 9, amountFactor: 0.0001 },
  ]);
  assert.ok(r.masking_flags.some((f) => f.type === "offsetting"), JSON.stringify(r.masking_flags));
});

// --- product metrics ---------------------------------------------------------------------------

test("product: the driver that moved carries the change, and the run drills into it", async () => {
  // amounts double in one group: volume is unchanged, the average amount rises
  const r = await run("volume_x_avg", [{ where: inP2Week5, okOutOf10: 9, amountFactor: 2 }]);
  assert.equal(r.status, "complete");
  assert.equal(r.headline!.kind, "product");
  assert.equal(r.headline!.metric, "volume_x_avg");
  assert.equal(r.drilled_driver, "avg_amount");
  assert.deepEqual(r.drivers!.map((d) => d.metric), ["n_rows", "avg_amount"]);
  const [volume, avg] = r.drivers!;
  assert.equal(volume.significant, false);
  assert.ok(avg.significant && avg.share! > 0.99);
  close(volume.share! + avg.share!, 1, 1e-6); // log shares add to one
  assert.equal(r.path[0].level, "driver");
  assert.equal(r.path[0].decision, "drill");
  assert.equal(r.findings[0].metric, "avg_amount");
  assert.equal(r.findings[0].value, "P2");
});

test("product: the other driver is followed when volume is what moved", async () => {
  const r = await run("volume_x_avg", [{ where: inP2Week5, okOutOf10: 9, extraOutOf10: 10 }]);
  assert.equal(r.drilled_driver, "n_rows");
  assert.equal(r.findings[0].metric, "n_rows");
  assert.equal(r.findings[0].value, "P2");
});

test("product: the product's change equals the sum of the driver changes it is split into", async () => {
  const r = await run("volume_x_avg", [{ where: () => true, okOutOf10: 9, amountFactor: 1.5 }].map((f) => ({ ...f, where: (x: { week: number }) => x.week === 5 }) as FaultSpec));
  const logTotal = r.drivers!.reduce((s, d) => s + Math.log(d.value / d.baseline), 0);
  close(logTotal, Math.log(r.headline!.value / r.headline!.baseline), 1e-9);
  close(r.drivers!.reduce((s, d) => s + d.share!, 0), 1, 1e-9);
});

test("product: when no single driver carries the change, the split is reported and the run stops there", async () => {
  // volume and amount both rise by 50%: each carries half the log change
  const r = await run("volume_x_avg", [{ where: (f) => f.week === 5, okOutOf10: 9, amountFactor: 1.5, extraOutOf10: 5 }]);
  assert.equal(r.status, "complete");
  assert.equal(r.drilled_driver, null);
  assert.deepEqual(r.findings, []);
  assert.equal(r.path[0].decision, "broad");
  assert.match(String(r.path[0].numbers.reason), /spread across the drivers/);
  assert.ok(r.drivers!.every((d) => d.significant && Math.abs(d.share! - 0.5) < 0.05));
});

test("product: an unchanged product has no dominant driver", async () => {
  const r = await run("volume_x_avg", []);
  assert.equal(r.drilled_driver, null);
  assert.match(String(r.path[0].numbers.reason), /no driver changed significantly/);
});

test("product: a driver that is zero cannot be log-split, so the run stops and says why", async () => {
  const r = await run("volume_x_avg", [{ where: (f) => f.week === 5, okOutOf10: 9, amountFactor: 0 }]);
  assert.equal(r.status, "stopped");
  assert.equal(r.stopped_reason, "product_driver_nonpositive");
  assert.match(r.stopped_detail!, /avg_amount/);
});

test("product: an unknown period stops like any other metric", async () => {
  const r = await run("volume_x_avg", [], "W99");
  assert.equal(r.stopped_reason, "period_not_found");
});

test("product: every query is logged, those of the split and those of the drill", async () => {
  const r = await run("volume_x_avg", [{ where: inP2Week5, okOutOf10: 9, amountFactor: 2 }]);
  assert.ok(r.steps.some((s) => s.id === "driver_split" && s.tool === "n_rows_series?aggregation=wk"));
  assert.ok(r.steps.some((s) => s.id === "where" && s.tool.startsWith("avg_amount_by_")));
});

test("headline.format: a rate reads as a fraction, an average or a total as a number", async () => {
  assert.equal((await run("m", [])).headline!.format, "fraction");
  assert.equal((await run("avg_amount", [])).headline!.format, "number", "a ratio of amounts is not a fraction");
  assert.equal((await run("total_amount", [])).headline!.format, "number");
  assert.equal((await run("volume_x_avg", [])).headline!.format, "number");
});

test("headline.relative_change: quotable for numbers, absent for a fraction", async () => {
  const total = await run("total_amount", [{ where: inP2Week5, okOutOf10: 9, amountFactor: 3 }]);
  close(total.headline!.relative_change!, total.headline!.change / total.headline!.baseline, 1e-12);
  assert.ok(total.headline!.relative_change! > 0.4);

  const product = await run("volume_x_avg", [{ where: inP2Week5, okOutOf10: 9, amountFactor: 2 }]);
  close(product.headline!.relative_change!, (product.headline!.value - product.headline!.baseline) / product.headline!.baseline, 1e-12);

  assert.equal((await run("m", [])).headline!.relative_change, undefined, "a rate's change is in points, not a share");
});
