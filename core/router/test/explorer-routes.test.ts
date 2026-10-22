import { test } from "node:test";
import assert from "node:assert/strict";
import { Ontology, Route } from "@causeline/schema";
import { explorationShape } from "../src/explore-shape.js";
import { route } from "../src/router.js";

// Neutral vocabulary: the router is domain-free.
const ontology = Ontology.parse({
  time: { levels: ["week", "day"], seasonality: "none" },
  hierarchies: { place: ["zone", "spot"] },
  dimensions: ["kind"],
  metrics: {
    pass_rate: { type: "ratio", direction: "higher_is_better", min_volume: 10, synonyms: ["success rate", "yield"] },
    scrap_rate: { type: "ratio", direction: "lower_is_better", min_volume: 10, synonyms: ["waste"] },
    total_cost: { type: "sum", direction: "lower_is_better", min_volume: 10, synonyms: ["spend", "cost"] },
  },
});
const periods = Array.from({ length: 10 }, (_, i) => `2026-W${String(i + 1).padStart(2, "0")}`);
const go = (question: string) => route({ question, ontology, agents: [], playbooks: ["metric_change", "value", "trend", "compare"], periods });

test("a ranking, a top list or a breakdown that names a KPI goes to the explorer, with the first read it suggests", () => {
  const cases: [string, Record<string, string | number>][] = [
    ["Which zone had the lowest pass rate in week 7?", { metric: "pass_rate", op: "rank", by: "zone", order: "lowest", period: "2026-W07" }],
    ["Which spot has the highest scrap rate?", { metric: "scrap_rate", op: "rank", by: "spot", order: "highest" }],
    ["Which kind had the worst pass rate last week?", { metric: "pass_rate", op: "rank", by: "kind", order: "lowest", period: "2026-W10" }],
    ["Which zone had the worst scrap rate last week?", { metric: "scrap_rate", op: "rank", by: "zone", order: "highest", period: "2026-W10" }],
    ["Top 3 zones by spend in week 7", { metric: "total_cost", op: "rank", by: "zone", order: "highest", top: 3, period: "2026-W07" }],
    ["bottom five spots for yield", { metric: "pass_rate", op: "rank", by: "spot", order: "lowest", top: 5 }],
    ["Show the pass rate by zone for last week", { metric: "pass_rate", op: "breakdown", by: "zone", period: "2026-W10" }],
    ["Break down waste by kind", { metric: "scrap_rate", op: "breakdown", by: "kind" }],
    ["What was the pass rate per zone in week 3?", { metric: "pass_rate", op: "breakdown", by: "zone", period: "2026-W03" }],
  ];
  for (const [question, inputs] of cases) {
    const r = go(question);
    assert.equal(r.strategy, "explorer", question);
    assert.deepEqual(r.options[0].inputs, inputs, question);
    assert.equal(r.options[0].expert, "explorer");
    assert.equal(r.options[0].status, "exploratory");
    assert.match(r.announce, /exploratory/);
    assert.match(r.announce, /no claim about cause/);
    assert.equal(r.needs, null);
    assert.doesNotThrow(() => Route.parse(r), question);
  }
});

test("questions an expert already covers are not taken by the explorer", () => {
  const stay: [string, string, string][] = [
    ["Why did the pass rate drop last week?", "pass_rate", "deep_rca"],
    ["Why was the zone with the lowest pass rate so low?", "pass_rate", "deep_rca"],
    ["What was the pass rate in week 3?", "pass_rate", "value"],
    ["How is the pass rate trending by zone?", "pass_rate", "trend"],
    ["compare the pass rate in week 7 vs week 6", "pass_rate", "compare"],
    ["What was the pass rate in the most recent week?", "pass_rate", "value"],
    ["How much waste did we have in week 8", "scrap_rate", "value"],
  ];
  for (const [question, kpi, task] of stay) {
    const r = go(question);
    assert.equal(r.strategy, "expert", question);
    assert.equal(r.options[0].kpi, kpi);
    assert.equal(r.options[0].task, task, question);
  }
});

test("the shape is read from the question and the pack's own concepts, and an extreme word with nothing to rank is not a ranking", () => {
  assert.deepEqual(explorationShape("which zone has the most waste", ontology, "scrap_rate"), { op: "rank", by: "zone", order: "highest" });
  assert.equal(explorationShape("what was the highest week", ontology, "pass_rate"), null, "a time word is not a concept to rank");
  assert.equal(explorationShape("the most recent week", ontology, "pass_rate"), null);
  assert.equal(explorationShape("why was the lowest zone low", ontology, "pass_rate"), null, "a why question is the analysis's");
  assert.deepEqual(explorationShape("rank the zones by yield", ontology, "pass_rate"), { op: "rank", by: "zone" });
});

test("a question that names no KPI still goes to the explorer, with no KPI named", () => {
  const r = go("Which zone should I close?");
  assert.equal(r.strategy, "explorer");
  assert.equal(r.options[0].kpi, null);
});
