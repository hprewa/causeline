import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentDef, Ontology, ResolvedIntent } from "@causeline/schema";
import { IntentSession, planRun } from "../src/index.js";

const ontology = {
  time: { levels: ["week", "day"], seasonality: "none" },
  hierarchies: { place: ["zone", "spot"] },
  dimensions: [],
  metrics: { rate: { type: "ratio", direction: "higher_is_better", min_volume: 0 }, count: { type: "sum", direction: "higher_is_better", min_volume: 0 } },
} as unknown as Ontology;
const labels = [
  { label: "2026-W09", start: "2026-03-02", end: "2026-03-08" },
  { label: "2026-W10", start: "2026-03-09", end: "2026-03-15" },
];
const win = (start: string, end: string, label?: string) => ({ start, end, days: 7, description: "d", ...(label ? { label } : {}) });
const resolved = (over: Partial<ResolvedIntent>): ResolvedIntent => ({ kpi: "rate", task: "deep_rca", window: win("2026-03-09", "2026-03-15"), aggregation: "", filters: {}, ...over });
const agents: AgentDef[] = [{ name: "rate-expert", kpi: "rate", task: "deep_rca", playbook: "own_playbook", examples: [], handoff: "none", status: "reconciled", unconfirmed_numbers: false, ladder: 2 }];

test("a deep dive runs the KPI's expert with dates, view, baseline and a scope for the filters", () => {
  const plan = planRun(resolved({ aggregation: "day", baseline: 6, filters: { spot: "s1" } }), { ontology, agents, labels });
  assert.equal(plan.kind, "run");
  if (plan.kind !== "run") return;
  assert.equal(plan.playbook, "own_playbook");
  assert.equal(plan.expert, "rate-expert");
  assert.equal(plan.status, "reconciled");
  assert.deepEqual(plan.inputs, { metric: "rate", start_date: "2026-03-09", end_date: "2026-03-15", aggregation: "day", baseline: 6, scope: '{"spot":"s1"}' });
});

test("with no expert of its own a KPI uses the core template for the task, and says it has not been checked", () => {
  for (const [task, playbook] of [["value", "value"], ["trend", "trend"], ["deep_rca", "metric_change"]] as const) {
    const plan = planRun(resolved({ kpi: "count", task }), { ontology, agents, labels });
    assert.ok(plan.kind === "run" && plan.playbook === playbook && plan.status === "draft", task);
  }
});

test("a window the person named by the data's own label is run by that label", () => {
  const plan = planRun(resolved({ window: win("2026-03-09", "2026-03-15", "2026-W10") }), { ontology, agents: [], labels });
  assert.ok(plan.kind === "run" && plan.inputs.period === "2026-W10" && plan.inputs.start_date === undefined);
});

test("a comparison runs on whole periods of the data, found by their days; otherwise it says why it cannot", () => {
  const ok = planRun(resolved({ task: "compare", window: win("2026-03-09", "2026-03-15"), against: win("2026-03-02", "2026-03-08") }), { ontology, agents: [], labels });
  assert.ok(ok.kind === "run" && ok.playbook === "compare" && ok.inputs.period === "2026-W10" && ok.inputs.against === "2026-W09");
  const no = planRun(resolved({ task: "compare", window: win("2026-03-10", "2026-03-16"), against: win("2026-03-02", "2026-03-08") }), { ontology, agents: [], labels });
  assert.ok(no.kind === "cannot" && /whole weeks of the data/.test(no.reason));
});

test("a session builds up, remembers answers, recalls one, and starts over", () => {
  const s = new IntentSession();
  s.set("how is the rate?", { kpi: "rate" });
  s.set("last week for zone z1", { task: "value", period: { kind: "relative", unit: "week", offset: 1, count: 1 }, filters: { zone: "z1" } });
  assert.deepEqual(s.unread, ["how is the rate?", "last week for zone z1"]);
  const r = resolved({ task: "value" });
  const first = s.record({ at: "t1", resolved: r, playback: "p1", summary: ["a"] }, "t1");
  assert.equal(first.n, 1);
  assert.deepEqual(first.said, ["how is the rate?", "last week for zone z1"]);
  assert.deepEqual(s.unread, [], "messages are counted again after a run");
  assert.equal(s.active.kpi, "rate", "the intent stays for a follow-up");

  // another KPI is a topic switch that says what carried over
  const { switched } = s.set("and the count?", { kpi: "count" });
  assert.deepEqual(switched, { from: "rate", to: "count", kept: ["the same period", "the same kind of question (value)", "zone z1"] });
  s.record({ at: "t2", resolved: r, playback: "p2", summary: [] }, "t2");

  const back = s.recall(1);
  assert.equal(back?.playback, "p1");
  assert.equal(s.active.kpi, "rate", "recall makes it active again");
  assert.equal(s.recall(9), undefined);

  s.startOver();
  assert.deepEqual(s.active, { filters: {} });
  assert.equal(s.history.length, 2, "answers survive starting over");
});

test("the first KPI of a conversation is not a topic switch", () => {
  const s = new IntentSession();
  assert.equal(s.set("rate", { kpi: "rate" }).switched, undefined);
  s.record({ at: "t", resolved: resolved({}), playback: "p", summary: [] }, "t");
  assert.equal(s.set("rate again", { kpi: "rate" }).switched, undefined, "the same KPI is not a switch");
});
