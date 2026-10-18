import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { buildFacts, FakeToolCaller, meta, ontology, seasonalMeta, seasonalOntology, type FaultSpec } from "./fake.js";

const playbook = loadPlaybook("metric_change", "no-such-pack");

/** Days 6 and 7 of every week are always worse (rate) and quieter (volume): a weekly pattern, not a fault. */
const weekendRate: FaultSpec = { where: (f) => f.day >= 6, okOutOf10: 6 };
const weekendQuiet: FaultSpec = { where: (f) => f.day >= 6, okOutOf10: 9, dropOutOf10: 5 };

async function run(ont: typeof ontology, faults: FaultSpec[], metric: string, period = "W5") {
  const result = await runPlaybook({ playbook, ontology: ont, meta: ont === ontology ? meta : seasonalMeta, tools: new FakeToolCaller(buildFacts(faults), ont), inputs: { metric, period } });
  assert.doesNotThrow(() => Result.parse(result));
  return result;
}

test("a weekly pattern is a finding without seasonality, and nothing with it", async () => {
  const naive = await run(ontology, [weekendRate], "m");
  assert.ok(naive.findings.length > 0 || naive.masking_flags.length > 0, "the pooled comparison blames the weekend");
  assert.equal(naive.seasonality?.status, "none_declared");
  assert.equal(naive.headline?.baseline_naive, undefined);

  const seasonal = await run(seasonalOntology, [weekendRate], "m");
  assert.equal(seasonal.status, "complete");
  assert.deepEqual(seasonal.findings, []);
  assert.deepEqual(seasonal.masking_flags, []);
  assert.equal(seasonal.seasonality?.status, "applied");
  assert.deepEqual(seasonal.seasonality?.cycles, ["weekday"]);
  assert.ok(Math.abs(seasonal.headline!.change) < 0.005);
  assert.ok(seasonal.headline!.baseline_naive !== undefined, "the pooled figure is kept for transparency");
});

test("with seasonality a genuinely bad day is still found, and only that day", async () => {
  const fault: FaultSpec = { where: (f) => f.week === 5 && f.day === 3, okOutOf10: 5 };
  const r = await run(seasonalOntology, [weekendRate, fault], "m");
  assert.equal(r.findings[0].dimension, "dy");
  assert.equal(r.findings[0].value, "W5-D3");
  assert.equal(r.findings.filter((f) => f.dimension === "dy").length, 1, "the weekend is not blamed as well");
});

test("totals: a quiet weekend is not a drop, and a surge on one weekday is located in time", async () => {
  const quiet = await run(seasonalOntology, [weekendQuiet], "n_rows");
  assert.deepEqual(quiet.findings, []);
  assert.deepEqual(quiet.masking_flags, []);

  const surge: FaultSpec = { where: (f) => f.week === 5 && f.day === 3, okOutOf10: 9, extraOutOf10: 10 };
  const r = await run(seasonalOntology, [weekendQuiet, surge], "n_rows");
  assert.equal(r.findings[0].dimension, "dy");
  assert.equal(r.findings[0].value, "W5-D3");
  assert.ok(r.findings[0].impact > 0);
});

test("no seasonality declared reproduces the pooled behaviour exactly", async () => {
  const fault: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 };
  const a = await run(ontology, [fault], "m");
  const b = await run({ ...ontology, time: { ...ontology.time, seasonality: "none" } }, [fault], "m");
  assert.deepEqual(a.findings, b.findings);
  assert.deepEqual(a.headline, b.headline);
});
