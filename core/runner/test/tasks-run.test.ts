import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { buildFacts, FakeToolCaller, meta, ontology, seasonalMeta, seasonalOntology, type FaultSpec } from "./fake.js";

const weekendRate: FaultSpec = { where: (f) => f.day >= 6, okOutOf10: 6 };
const badWeek5: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 4 };

async function run(playbook: string, faults: FaultSpec[], metric: string, inputs: Record<string, string | number> = {}, seasonal = false) {
  const ont = seasonal ? seasonalOntology : ontology;
  const r = await runPlaybook({
    playbook: loadPlaybook(playbook, "no-such-pack"),
    ontology: ont,
    meta: seasonal ? seasonalMeta : meta,
    tools: new FakeToolCaller(buildFacts(faults), ont),
    inputs: { metric, period: "W5", ...inputs },
  });
  assert.doesNotThrow(() => Result.parse(r));
  return r;
}

test("value: a quiet week is not a change, and a real drop is, with its z-score", async () => {
  const clean = await run("value", [weekendRate], "m", {}, true);
  assert.equal(clean.status, "complete");
  assert.equal(clean.headline!.significant, false);
  assert.ok(Math.abs(clean.headline!.change) < 0.005);
  assert.ok(clean.headline!.z !== undefined);
  assert.deepEqual(clean.findings, [], "a value question does not drill");

  const bad = await run("value", [weekendRate, badWeek5], "m", {}, true);
  assert.equal(bad.headline!.significant, true);
  assert.ok(bad.headline!.change < -0.01);
});

test("trend: every period against its own baseline, change points where it left it, and a weekend pattern is not one", async () => {
  const clean = await run("trend", [weekendRate], "m", {}, true);
  assert.ok(clean.trend!.buckets.length >= 5);
  assert.deepEqual(clean.trend!.change_points, []);

  const bad = await run("trend", [weekendRate, badWeek5], "m", {}, true);
  // W5 is where it left its baseline; W6 then reads as a change the other way because its baseline now holds the bad W5
  assert.deepEqual(bad.trend!.change_points, ["W5", "W6"]);
  assert.ok(bad.trend!.buckets.find((b) => b.bucket === "W6")!.z! > 0, "the recovery is a move in the opposite direction");
  const w5 = bad.trend!.buckets.find((b) => b.bucket === "W5")!;
  assert.equal(w5.significant, true);
  assert.ok(w5.value! < w5.expected!);
  assert.equal(bad.trend!.buckets[0].expected, null, "the first period has nothing before it");
  assert.equal(bad.trend!.level, "wk");
});

test("trend works for a total too", async () => {
  const surge: FaultSpec = { where: (f) => f.week === 5, okOutOf10: 9, extraOutOf10: 10 };
  const r = await run("trend", [surge], "n_rows");
  assert.ok(r.trend!.change_points.includes("W5"));
});

test("compare: two periods, and two values of one concept", async () => {
  const periods = await run("compare", [badWeek5], "m", { period: "W5", against: "W4" });
  assert.equal(periods.comparison!.kind, "periods");
  assert.ok(periods.comparison!.difference < -0.01);
  assert.equal(periods.comparison!.significant, true);
  assert.deepEqual([periods.comparison!.a.label, periods.comparison!.b.label], ["W5", "W4"]);

  const nodes = await run("compare", [badWeek5], "m", { concept: "a2", a: "P1", b: "P2" });
  assert.equal(nodes.comparison!.kind, "nodes");
  assert.ok(nodes.comparison!.difference > 0.05, "P1 is better than P2 in week 5");
  assert.equal(nodes.comparison!.significant, true);

  const same = await run("compare", [], "m", { concept: "a2", a: "P1", b: "P2" });
  assert.equal(same.comparison!.significant, false);
});

test("compare says what it needs, and what it could not find", async () => {
  const none = await run("compare", [], "m");
  assert.equal(none.stopped_reason, "needs_inputs");
  const half = await run("compare", [], "m", { concept: "a2", a: "P1" });
  assert.equal(half.stopped_reason, "needs_inputs");
  const ghost = await run("compare", [], "m", { concept: "a2", a: "P1", b: "ZZ" });
  assert.equal(ghost.stopped_reason, "node_not_found");
  assert.match(ghost.stopped_detail ?? "", /ZZ not found.*available: P1/);
  const noPeriod = await run("compare", [], "m", { against: "W99" });
  assert.equal(noPeriod.stopped_reason, "period_not_found");
});

test("a product KPI is only asked why it changed; the simple templates say so", async () => {
  const r = await run("value", [], "volume_x_avg");
  assert.equal(r.status, "stopped");
  assert.equal(r.stopped_reason, "product_not_supported");
  assert.match(r.stopped_detail ?? "", /n_rows and avg_amount/);
});
