import { test } from "node:test";
import assert from "node:assert/strict";
import { Playbook, Result } from "@causeline/schema";
import { checkPlaybook } from "../src/validate.js";
import { runPlaybook } from "../src/runner.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const fault: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 };
const make = (steps: object[]) => Playbook.parse({ name: "branching", description: "d", inputs: { metric: { type: "string" }, period: { type: "string", default: "" } }, steps });
async function run(playbook: Playbook, faults: FaultSpec[], period = "W5") {
  const r = await runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(faults)), inputs: { metric: "m", period } });
  assert.doesNotThrow(() => Result.parse(r));
  return r;
}

const gated = make([
  { id: "data_check", compute: "coverage_and_counts" },
  { id: "headline", compute: "change_vs_baseline", next: [{ if: "headline.significant == false", then: { stop: "nothing_to_explain" } }, { else: "where" }] },
  { id: "where", compute: "guided_drill", over: "hierarchies" },
]);

test("the playbook is sound", () => assert.deepEqual(checkPlaybook(gated), []));

test("a rule ends the run early, and the trace says which rule and why", async () => {
  const r = await run(gated, []);
  assert.equal(r.status, "stopped");
  assert.equal(r.stopped_reason, "nothing_to_explain");
  assert.deepEqual(r.trace.map((t) => t.step), ["data_check", "headline"]);
  const last = r.trace[1];
  assert.match(last.rule!, /headline.significant == false/);
  assert.match(last.because!, /headline.significant = false/);
});

test("the else branch continues, and the rule that did not hold is recorded", async () => {
  const r = await run(gated, [fault]);
  assert.equal(r.status, "complete");
  assert.deepEqual(r.trace.map((t) => t.step), ["data_check", "headline", "where"]);
  const headline = r.trace[1];
  assert.match(headline.rule!, /^else "where"/);
  assert.equal(headline.skipped.length, 1);
  assert.match(headline.skipped[0], /headline.significant = true/);
  assert.equal(r.findings[0].value, "P2");
});

test("a step with a condition is skipped when it does not hold, and the trace says so", async () => {
  const p = make([
    { id: "data_check", compute: "coverage_and_counts" },
    { id: "headline", compute: "change_vs_baseline" },
    { id: "where", compute: "guided_drill", over: "hierarchies", when: "headline.significant" },
    { id: "extra", compute: "persistence", when: "where.found > 0" },
  ]);
  const quiet = await run(p, []);
  assert.deepEqual(quiet.trace.filter((t) => t.rule?.startsWith("skipped")).map((t) => t.step), ["where", "extra"]);
  assert.deepEqual(quiet.findings, []);
  const loud = await run(p, [fault]);
  assert.deepEqual(loud.trace.filter((t) => t.rule?.startsWith("skipped")).map((t) => t.step), []);
});

test("a loop runs only as often as the step allows, then the run stops with a reason", async () => {
  const p = make([
    { id: "data_check", compute: "coverage_and_counts" },
    { id: "headline", compute: "change_vs_baseline", max_visits: 2, next: [{ if: "headline.z != null", then: "headline" }, { else: "again" }] },
    { id: "again", compute: "persistence" },
  ]);
  assert.deepEqual(checkPlaybook(p), []);
  const r = await run(p, [fault]);
  assert.equal(r.stopped_reason, "loop_limit");
  assert.equal(r.trace.filter((t) => t.step === "headline").length, 2);
});
