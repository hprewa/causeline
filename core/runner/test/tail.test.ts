import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const playbook = loadPlaybook("metric_change", "no-such-pack");

async function run(faults: FaultSpec[], period: string, weeks: number) {
  return runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(faults, weeks)), inputs: { metric: "m", period } });
}

const arriving = (week: number): FaultSpec => ({ where: (f) => f.week === week, okOutOf10: 9, dropOutOf10: 4 });

test("a newest period holding far less than usual is data still arriving, and the run says so", async () => {
  const r = await run([arriving(8)], "W8", 8);
  assert.equal(r.status, "stopped");
  assert.equal(r.stopped_reason, "data_still_arriving");
  assert.match(r.stopped_detail ?? "", /still arriving/);
  assert.deepEqual(r.findings, []);
});

test("the settled periods before the tail are analysed as usual", async () => {
  const r = await run([arriving(8)], "W7", 8);
  assert.notEqual(r.stopped_reason, "data_still_arriving");
  assert.equal(r.status, "complete");
});

test("the same shortfall in a period that later periods recovered from is not a tail", async () => {
  const r = await run([arriving(6)], "W6", 8);
  assert.notEqual(r.stopped_reason, "data_still_arriving");
});

test("clean data is not a tail", async () => {
  const r = await run([], "W8", 8);
  assert.notEqual(r.stopped_reason, "data_still_arriving");
});
