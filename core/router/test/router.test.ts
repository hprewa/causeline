import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentDef, Ontology, Route } from "@causeline/schema";
import { effectiveExperts, resolvePeriods, route } from "../src/router.js";

// Neutral vocabulary: the router is domain-free.
const ontology = Ontology.parse({
  time: { levels: ["week", "day"], seasonality: "none" },
  hierarchies: { place: ["zone", "spot"] },
  dimensions: ["kind"],
  metrics: {
    pass_rate: { type: "ratio", direction: "higher_is_better", min_volume: 10, synonyms: ["success rate", "yield"] },
    scrap_rate: { type: "ratio", direction: "lower_is_better", min_volume: 10, synonyms: ["waste"] },
    total_cost: { type: "sum", direction: "lower_is_better", min_volume: 10, synonyms: ["spend", "cost"] },
    unit_cost: { type: "ratio", direction: "lower_is_better", min_volume: 10, synonyms: ["cost per unit"] },
    cost_load: { type: "product", drivers: ["total_cost", "pass_rate"], direction: "lower_is_better", synonyms: ["load"] },
  },
});
const periods = Array.from({ length: 10 }, (_, i) => `2026-W${String(i + 1).padStart(2, "0")}`);
const agents = [AgentDef.parse({ name: "pass-rate-rca", kpi: "pass_rate", task: "deep_rca", playbook: "pass_drop", status: "verified", examples: ["why did the pass rate drop?"] })];
const members = { zone: ["North", "South", "East"] };

const go = (question: string, extra: Partial<Parameters<typeof route>[0]> = {}) =>
  route({ question, ontology, agents, playbooks: ["pass_drop", "metric_change", "value", "trend", "compare"], periods, ...extra });

// [question, kpi, task, period | null, needs | null]
const TABLE: [string, string, string, string | null, string | null][] = [
  ["Why did the pass rate drop last week?", "pass_rate", "deep_rca", "2026-W10", null],
  ["why did yield fall in week 7", "pass_rate", "deep_rca", "2026-W07", null],
  ["What was the success rate in week 3?", "pass_rate", "value", "2026-W03", null],
  ["How much waste did we have in 2026-W08", "scrap_rate", "value", "2026-W08", null],
  ["how is scrap rate trending", "scrap_rate", "trend", "2026-W10", null],
  ["Show me the trend in spend over time", "total_cost", "trend", "2026-W10", null],
  ["What happened to unit cost this week?", "unit_cost", "deep_rca", "2026-W10", null],
  ["did anything unusual happen to the pass rate in week 4?", "pass_rate", "deep_rca", "2026-W04", null],
  ["pass rate", "pass_rate", "value", null, "period"],
  ["why did pass rate drop?", "pass_rate", "deep_rca", null, "period"],
  ["Why did the pas rate drop last week?", "pass_rate", "deep_rca", "2026-W10", null],
  ["What is the cost per unit for the week before last?", "unit_cost", "value", "2026-W09", null],
  ["Why did the cost load change in week 6?", "cost_load", "deep_rca", "2026-W06", null],
  ["What was the cost load last week?", "cost_load", "deep_rca", "2026-W10", null],
];

for (const [question, kpi, task, period, needs] of TABLE) {
  test(`routes: ${question}`, () => {
    const r = go(question);
    assert.equal(r.strategy, "expert");
    assert.equal(r.options[0].kpi, kpi);
    assert.equal(r.options[0].task, task);
    assert.equal(r.options[0].inputs.period ?? null, needs ? (task === "trend" ? r.options[0].inputs.period ?? null : null) : period);
    assert.equal(r.needs?.input ?? null, needs);
    assert.doesNotThrow(() => Route.parse(r));
  });
}

test("a verified expert with its own playbook is chosen, and the answer says so; a generic one is flagged as unverified", () => {
  const verified = go("why did the pass rate drop last week?");
  assert.equal(verified.options[0].expert, "pass-rate-rca");
  assert.equal(verified.options[0].playbook, "pass_drop");
  assert.equal(verified.options[0].status, "verified");
  assert.doesNotMatch(verified.announce, /unverified/);

  const generic = go("why did scrap rate drop last week?");
  assert.equal(generic.options[0].expert, "scrap_rate-deep_rca");
  assert.equal(generic.options[0].playbook, "metric_change");
  assert.equal(generic.options[0].status, "draft");
  assert.match(generic.announce, /generic expert .* not been verified/);
});

test("an expert whose playbook does not exist falls back to the core template", () => {
  const r = go("why did the pass rate drop last week?", { playbooks: ["metric_change"] });
  assert.equal(r.options[0].playbook, "metric_change");
});

test("a vague question with no KPI scans every KPI for the period", () => {
  const r = go("Why was last week bad?");
  assert.equal(r.strategy, "scan");
  assert.equal(r.scan?.period, "2026-W10");
  assert.deepEqual(r.options.map((o) => o.kpi), Object.keys(ontology.metrics));
  assert.equal(r.needs, null);
  assert.match(r.announce, /every KPI/);
  const noPeriod = go("Is something wrong?");
  assert.equal(noPeriod.strategy, "scan");
  assert.equal(noPeriod.needs?.input, "period");
  assert.deepEqual(noPeriod.needs?.choices, ["2026-W10", "2026-W09", "2026-W08"]);
});

test("a question nothing covers goes to the explorer and says so", () => {
  for (const q of ["What is the weather like?", "Who is our biggest supplier?"]) {
    const r = go(q);
    assert.equal(r.strategy, "explorer");
    assert.equal(r.options[0].expert, "explorer");
    assert.equal(r.options[0].status, "exploratory");
    assert.match(r.announce, /exploratory/);
  }
});

test("two KPIs that match equally well become one question, not a guess", () => {
  const r = go("what was the cost last week?");
  // "cost" is a synonym of total_cost and the start of unit_cost's own name: the longer, more specific match wins
  assert.equal(r.options[0].kpi, "total_cost");
  const tie = route({ question: "yield or waste last week", ontology, agents, playbooks: [], periods });
  assert.equal(tie.needs?.input, "kpi");
  assert.deepEqual(tie.needs?.choices, ["pass_rate", "scrap_rate"]);
  assert.match(tie.announce, /pass rate or scrap rate/);
});

test("compare: two periods, two values of one concept, or one question", () => {
  const periodsOnly = go("compare the pass rate in week 7 vs week 6");
  assert.equal(periodsOnly.options[0].task, "compare");
  assert.deepEqual([periodsOnly.options[0].inputs.period, periodsOnly.options[0].inputs.against], ["2026-W07", "2026-W06"]);
  assert.equal(periodsOnly.needs, null);

  const nodes = go("pass rate in South versus North last week", { members });
  assert.deepEqual([nodes.options[0].inputs.concept, nodes.options[0].inputs.a, nodes.options[0].inputs.b, nodes.options[0].inputs.period], ["zone", "South", "North", "2026-W10"]);
  assert.match(nodes.announce, /South against North/);

  const vague = go("compare the pass rate");
  assert.equal(vague.needs?.input, "against");
});

test("a product KPI is only asked why it changed, and the route says so", () => {
  const r = go("what was the load last week?");
  assert.equal(r.options[0].task, "deep_rca");
  assert.ok(r.options[0].reasons.some((x) => /only why it changed is available/.test(x)));
});

test("periods: labels, numbers, relative words, and none", () => {
  assert.deepEqual(resolvePeriods("compare week 7 and week 3", periods, "week"), ["2026-W07", "2026-W03"]);
  assert.deepEqual(resolvePeriods("what about 2026-W02?", periods, "week"), ["2026-W02"]);
  assert.deepEqual(resolvePeriods("how was last week", periods, "week"), ["2026-W10"]);
  assert.deepEqual(resolvePeriods("the week before last", periods, "week"), ["2026-W09"]);
  assert.deepEqual(resolvePeriods("week 99", periods, "week"), []);
  assert.deepEqual(resolvePeriods("anything", periods, "week"), []);
});

test("every KPI gets a generic expert for every task, and a named expert replaces its generic one", () => {
  const all = effectiveExperts(ontology, agents);
  assert.equal(all.length, 5 * 4);
  assert.equal(all.filter((a) => a.kpi === "pass_rate" && a.task === "deep_rca").length, 1);
  assert.equal(all.find((a) => a.kpi === "pass_rate" && a.task === "deep_rca")!.name, "pass-rate-rca");
});
