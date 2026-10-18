import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const playbook = loadPlaybook("metric_change", "no-such-pack");

async function run(faults: FaultSpec[], period: string, extra: Record<string, string | number> = {}) {
  const result = await runPlaybook({
    playbook,
    ontology,
    meta,
    tools: new FakeToolCaller(buildFacts(faults)),
    inputs: { metric: "m", period, ...extra },
  });
  assert.doesNotThrow(() => Result.parse(result), "result validates against the result schema");
  return result;
}

test("clean data: no findings, no masking flags", async () => {
  const r = await run([], "W5");
  assert.equal(r.status, "complete");
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.masking_flags, []);
  assert.ok(Math.abs(r.headline!.change) < 0.005);
});

test("planted fault: the deepest, most specific explanation ranks first", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 }], "W5");
  assert.equal(r.status, "complete");
  assert.ok(r.headline!.change < -0.01);
  assert.equal(r.findings[0].dimension, "d1");
  assert.equal(r.findings[0].value, "Y");
  assert.deepEqual(r.findings[0].scope, { a2: "P2" });
  assert.equal(r.findings[0].persistence, "persistent");
  // the node itself is the second finding; the network-wide Y finding was merged into the scoped one
  assert.equal(r.findings[1].dimension, "a2");
  assert.equal(r.findings[1].value, "P2");
  assert.ok(r.findings[0].evidence.includes("flat") && r.findings[0].evidence.includes("refine"));
  assert.equal(r.findings.length, 2);
});

test("path records every level visited, with the decision at each", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 }], "W5");
  const h1 = r.path.filter((p) => p.hierarchy === "h1");
  assert.deepEqual(h1.map((p) => [p.level, p.node, p.decision]), [["a1", "P", "drill"], ["a2", "P2", "drill"]]);
  assert.equal(h1[1].parent, "P");
  // the fault touches both halves of h2 equally, so nothing dominates there
  assert.equal(r.path.find((p) => p.hierarchy === "h2")!.decision, "broad");
});

test("a change confined to one day narrows the window to that day", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.day === 3, okOutOf10: 3 }], "W5");
  const time = r.path.find((p) => p.hierarchy === "time")!;
  assert.equal(time.decision, "drill");
  assert.equal(time.node, "W5-D3");
  assert.match(r.window!.start, /^2026-02-0[0-9]|^2026-01-3/);
  assert.equal(r.window!.start.slice(0, 10), r.window!.end.slice(0, 10), "window is a single day");
  // narrowing to a slot is itself a finding
  assert.equal(r.findings[0].dimension, "dy");
  assert.equal(r.findings[0].value, "W5-D3");
  assert.ok(r.findings[0].impact < -0.01);
});

test("time masking: a bad day inside a week that looks normal is still found", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.day === 3, okOutOf10: 8 }], "W5");
  assert.ok(Math.abs(r.headline!.change) < 0.02, "the week-level change is small");
  const time = r.path.find((p) => p.hierarchy === "time")!;
  assert.equal(time.decision, "masked");
  assert.equal(time.node, "W5-D3");
  assert.ok(r.masking_flags.some((f) => f.type === "dispersion" && f.level === "dy"));
  assert.equal(r.findings[0].dimension, "dy");
  assert.equal(r.findings[0].value, "W5-D3");
});

test("offset hidden below the top level: siblings cancel inside a parent that looks flat", async () => {
  const r = await run(
    [
      { where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 8 },
      { where: (f) => f.week === 5 && f.a2 === "P1", okOutOf10: 10 },
    ],
    "W5",
  );
  assert.ok(Math.abs(r.headline!.change) < 0.005, "the total looks flat");
  // the top-level drill finds nothing, so the deeper level is swept across all nodes
  const first = r.path.find((p) => p.hierarchy === "h1")!;
  assert.equal(first.level, "a1");
  assert.equal(first.decision, "broad");
  const swept = r.path.find((p) => p.hierarchy === "h1" && p.parent === "(all)")!;
  assert.equal(swept.level, "a2");
  assert.equal(swept.decision, "masked");
  assert.equal(swept.node, "P2");
  assert.ok(r.masking_flags.some((f) => f.type === "offsetting" && f.level === "a2"));
  assert.equal(r.findings[0].dimension, "a2");
  assert.equal(r.findings[0].value, "P2");
});

test("clean data is not swept into false findings", async () => {
  const r = await run([], "W5");
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.masking_flags, []);
});

test("a change spread over the whole period leaves the window as the period", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 3 }], "W5");
  assert.equal(r.path.find((p) => p.hierarchy === "time")!.decision, "broad");
});

test("offsetting: one group drops while another improves by the same amount", async () => {
  const r = await run(
    [
      { where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 7 },
      { where: (f) => f.week === 5 && (f.a2 === "Q1" || f.a2 === "Q2"), okOutOf10: 10 },
    ],
    "W5",
  );
  assert.ok(Math.abs(r.headline!.change) < 0.005, "the total looks flat");
  assert.ok(r.masking_flags.some((f) => f.type === "offsetting" && f.level === "a1"));
  assert.equal(r.findings[0].dimension, "a2");
  assert.equal(r.findings[0].value, "P2");
});

test("missing data stops the run with data_quality and names the node", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.a2 === "Q1", okOutOf10: 9, dropOutOf10: 8 }], "W5");
  assert.equal(r.status, "stopped");
  assert.equal(r.stopped_reason, "data_quality");
  assert.match(r.stopped_detail!, /a2=Q1/);
  assert.deepEqual(r.findings, []);
  assert.equal(r.headline, null);
});

test("an unknown period stops the run instead of throwing", async () => {
  const r = await run([], "W99");
  assert.equal(r.stopped_reason, "period_not_found");
});

test("the first period has no baseline", async () => {
  const r = await run([], "W1");
  assert.equal(r.stopped_reason, "no_baseline");
});

test("every tool call is logged with name, params, rows and duration", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 3 }], "W5");
  assert.ok(r.steps.length > 5);
  for (const s of r.steps) {
    assert.ok(s.tool && s.id);
    assert.ok(s.rows >= 0 && s.ms >= 0);
  }
  assert.ok(r.steps.some((s) => s.id === "data_check" && s.tool === "m_extent"));
});

test("a threshold can be overridden by a run input", async () => {
  const fault: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 3 };
  const lenient = await run([fault], "W5");
  assert.equal(lenient.findings[0].value, "P2");
  // demanding an unreachable share means no child ever dominates
  const strict = await run([fault], "W5", { drill_share: 1.5 });
  assert.notEqual(strict.path.find((p) => p.hierarchy === "h1")!.decision, "drill");
});

test("missing and mistyped inputs are rejected", async () => {
  await assert.rejects(runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts()), inputs: { metric: "m" } }), /needs input "period"/);
  await assert.rejects(runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts()), inputs: { metric: "nope", period: "W5" } }), /not in the ontology/);
  await assert.rejects(runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts()), inputs: { metric: "m", period: "W5", baseline: "lots" } }), /must be a number/);
});
