import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentDef, Route, RoutingCase } from "../src/agent.js";
import { DataDefs } from "../src/data.js";
import { Ontology } from "../src/ontology.js";
import { Playbook } from "../src/playbook.js";
import { validatePack } from "../src/validate-pack.js";

const ontology = Ontology.parse({
  time: { levels: ["week", "day"], seasonality: "none" },
  hierarchies: { h: ["a", "b"] },
  dimensions: [],
  metrics: { m: { type: "ratio", direction: "higher_is_better", min_volume: 5 } },
});
const data = DataDefs.parse({ source: "s", facts: { f: { sql: "SELECT 1", time: "ts", concepts: ["a", "b"] } }, metrics: { m: { fact: "f", numerator: "1" } } });
const pb = Playbook.parse({ name: "custom", description: "d", steps: [{ id: "a", compute: "coverage_and_counts" }] });

test("an expert defaults to a draft with no hand-off, and needs a known task", () => {
  const a = AgentDef.parse({ name: "m-value", kpi: "m", task: "value" });
  assert.deepEqual([a.status, a.handoff, a.examples], ["draft", "none", []]);
  assert.throws(() => AgentDef.parse({ name: "x", kpi: "m", task: "mix" }));
});

test("experts are checked against the ontology and the playbooks", () => {
  const issues = (agents: unknown[]) => validatePack({ ontology, data, playbooks: [pb], agents: agents.map((a) => AgentDef.parse(a)) });
  assert.deepEqual(issues([{ name: "ok", kpi: "m", task: "deep_rca", playbook: "custom", ladder: 2, status: "reconciled", examples: ["why?"] }]).errors, []);
  assert.match(issues([{ name: "x", kpi: "ghost", task: "value" }]).errors.join(), /KPI "ghost"/);
  assert.match(issues([{ name: "x", kpi: "m", task: "value", playbook: "nope" }]).errors.join(), /playbook "nope"/);
  assert.match(issues([{ name: "x", kpi: "m", task: "value" }, { name: "x", kpi: "m", task: "trend" }]).errors.join(), /two experts/);
  assert.match(issues([{ name: "x", kpi: "m", task: "value", ladder: 2, status: "reconciled" }]).warnings.join(), /no example questions/);
});

test("a route and a routing case parse", () => {
  const r = Route.parse({ question: "q", strategy: "expert", announce: "I will check.", options: [{ kpi: "m", task: "value", expert: "m-value", playbook: "value", status: "draft", confidence: 0.8 }] });
  assert.equal(r.needs, null);
  assert.equal(RoutingCase.parse({ question: "q", expect: { kpi: "m", needs: "period" } }).expect.needs, "period");
});
