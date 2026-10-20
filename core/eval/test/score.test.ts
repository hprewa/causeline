import { test } from "node:test";
import assert from "node:assert/strict";
import { Result, type Expectation } from "@causeline/schema";
import { namesValue, numbersIn, scoreAgent, scoreRunner, untracedNumbers } from "../src/score.js";

const generator = { name: "causeline", version: "0.1.0", url: "https://example.com/causeline" };

function result(over: Record<string, unknown> = {}): Result {
  return Result.parse({
    playbook: "metric_change",
    inputs: { metric: "m", period: "2026-W10", baseline: 4 },
    status: "complete",
    headline: { metric: "m", value: 0.9209, baseline: 0.9311, change: -0.0102 },
    findings: [{ rank: 1, dimension: "d1", value: "Y", impact: -0.009, evidence: ["refine"], scope: { a2: "P2" }, effect: "rate" }],
    path: [{ level: "a2", node: "P2", decision: "drill", hierarchy: "h1", parent: "P", numbers: {} }],
    masking_flags: [{ level: "a1", type: "offsetting", detail: "children cancel" }],
    steps: [],
    generator,
    ...over,
  });
}

const expectation = (e: Expectation) => e;

test("runner: a matching top finding, scope and effect pass", () => {
  const s = scoreRunner(result(), expectation({ top_finding: { dimension: "d1", value: "Y", scope: { a2: "P2" }, effect: "rate" } }));
  assert.equal(s.pass, true);
});

test("runner: a wrong value, scope or effect fails with a useful detail", () => {
  const wrongValue = scoreRunner(result(), expectation({ top_finding: { dimension: "d1", value: "Z" } }));
  assert.equal(wrongValue.pass, false);
  assert.match(wrongValue.checks[0].detail!, /expected d1=Z, got d1=Y/);
  assert.equal(scoreRunner(result(), expectation({ top_finding: { dimension: "d1", value: "Y", scope: { a2: "Q1" } } })).pass, false);
  assert.equal(scoreRunner(result(), expectation({ top_finding: { dimension: "d1", value: "Y", effect: "mix" } })).pass, false);
});

test("runner: only the top-ranked finding counts as the top finding", () => {
  const r = result({ findings: [{ rank: 1, dimension: "a2", value: "P2", impact: -0.01 }, { rank: 2, dimension: "d1", value: "Y", impact: -0.009 }] });
  assert.equal(scoreRunner(r, expectation({ top_finding: { dimension: "d1", value: "Y" } })).pass, false);
});

test("runner: stopped_reason, no_findings and masking flags", () => {
  const stopped = result({ status: "stopped", findings: [], stopped_reason: "data_quality", stopped_detail: "a2=Q1 has too few rows" });
  assert.equal(scoreRunner(stopped, expectation({ stopped_reason: "data_quality", must_mention: ["Q1"] })).pass, true);
  assert.equal(scoreRunner(stopped, expectation({ stopped_reason: "empty_data" })).pass, false);

  const clean = result({ findings: [], masking_flags: [] });
  assert.equal(scoreRunner(clean, expectation({ no_findings: true })).pass, true);
  assert.equal(scoreRunner(result(), expectation({ no_findings: true })).pass, false);

  assert.equal(scoreRunner(result(), expectation({ masking_flags: ["offsetting"] })).pass, true);
  assert.equal(scoreRunner(result(), expectation({ masking_flags: ["dispersion"] })).pass, false);
});

test("runner: must_mention searches the whole drill, must_not_claim only the findings", () => {
  // P2 appears in the path and the finding scope, so it can be mentioned
  assert.equal(scoreRunner(result(), expectation({ must_mention: ["p2"] })).pass, true);
  assert.equal(scoreRunner(result(), expectation({ must_mention: ["nowhere"] })).pass, false);
  // a node the drill merely visited is not a claim; a finding is
  assert.equal(scoreRunner(result(), expectation({ must_not_claim: ["P1"] })).pass, true);
  assert.equal(scoreRunner(result(), expectation({ must_not_claim: ["Y"] })).pass, false);
});

test("numbersIn skips identifiers and dates and keeps real figures", () => {
  assert.deepEqual(numbersIn("site_02 in W10 (2026-03-11) fell -0.9 pts across 12 rows, then 3 sites."), [-0.9, 12, 3]);
  assert.deepEqual(numbersIn("C3 and 2026-W10"), []);
});

test("untracedNumbers accepts rounded, percent and sign-flipped forms of result values", () => {
  const r = result();
  const bad = untracedNumbers("success rate fell 1.0 points, from 93.1% to 92.1%, over the last 4 weeks.", r, "Why did success rate drop in week 10?");
  assert.deepEqual(bad, []);
});

test("untracedNumbers reports figures the result does not contain", () => {
  const bad = untracedNumbers("success rate fell 7 points and cost the business 40000 dollars.", result(), "Why?");
  assert.deepEqual(bad, ["7", "40000"]);
});

test("numbers from the question are allowed in the narrative", () => {
  assert.deepEqual(untracedNumbers("In week 10 specifically, success rate fell.", null, "Why did success rate drop in week 10?"), []);
});

const agentEvidence = (narrative: string, over: Record<string, unknown> = {}) => ({
  narrative,
  toolCalls: [{ name: "mcp__plugin_causeline_causeline-mcp__run_playbook", input: { name: "metric_change", inputs: { metric: "m" } } }],
  result: result(),
  question: "Why did m drop in week 10?",
  expectedPlaybook: "metric_change",
  ...over,
});

test("agent: right playbook, names the finding, numbers traceable, no forbidden claim", () => {
  const s = scoreAgent(agentEvidence("The drop of 1.0 points traces to d1 Y inside a2 P2 (step refine)."), expectation({ top_finding: { dimension: "d1", value: "Y", scope: { a2: "P2" } }, must_not_claim: ["shortage"] }));
  assert.equal(s.pass, true, JSON.stringify(s.checks.filter((c) => !c.ok)));
});

test("agent: fails when it never ran the playbook, invents a number, or makes a forbidden claim", () => {
  const noCall = scoreAgent(agentEvidence("It was Y in P2.", { toolCalls: [], result: null }), expectation({ top_finding: { dimension: "d1", value: "Y" } }));
  assert.equal(noCall.pass, false);
  assert.ok(noCall.checks.find((c) => c.name === "playbook_called" && !c.ok));

  const invented = scoreAgent(agentEvidence("Y in P2 cost 5 million."), expectation({ top_finding: { dimension: "d1", value: "Y" } }));
  assert.ok(invented.checks.find((c) => c.name === "numbers_traceable" && !c.ok));

  const claimed = scoreAgent(agentEvidence("A shortage in P2 explains Y."), expectation({ top_finding: { dimension: "d1", value: "Y" }, must_not_claim: ["shortage"] }));
  assert.ok(claimed.checks.find((c) => c.name === "must_not_claim:shortage" && !c.ok));
});

test("agent: a stopped run must be reported as stopped", () => {
  const stopped = result({ status: "stopped", findings: [], stopped_reason: "data_quality" });
  const good = scoreAgent(agentEvidence("The run stopped because of a data quality problem at Q1.", { result: stopped }), expectation({ stopped_reason: "data_quality" }));
  assert.equal(good.checks.find((c) => c.name === "narrative_reports_stop")!.ok, true);
  const bad = scoreAgent(agentEvidence("Y caused it.", { result: stopped }), expectation({ stopped_reason: "data_quality" }));
  assert.equal(bad.checks.find((c) => c.name === "narrative_reports_stop")!.ok, false);
});

test("a thousands separator does not split a number", () => {
  assert.deepEqual(numbersIn("on 3,163 requests and 12,000,000 more"), [3163, 12000000]);
  assert.deepEqual(untracedNumbers("C6 carried 3,163 requests.", result({ path: [{ level: "channel", node: "C6", decision: "masked", numbers: { culprit_volume: 3163 } }] }), "q"), []);
});

test("hyphens, underscores and spaces are interchangeable when looking for a phrase", () => {
  const stopped = result({ status: "stopped", findings: [], stopped_reason: "data_quality" });
  const ev = agentEvidence("It stopped on a data-quality check.", { result: stopped });
  assert.equal(scoreAgent(ev, expectation({ stopped_reason: "data_quality" })).checks.find((c) => c.name === "narrative_reports_stop")!.ok, true);
  assert.equal(scoreRunner(result({ findings: [{ rank: 1, dimension: "d", value: "item_group_B", impact: -0.1 }] }), expectation({ must_mention: ["item group b"] })).pass, true);
});

test("a slot label may be reworded by a person; its distinctive parts must still appear", () => {
  const label = "2026-02-11 12:00..2026-02-11 12:30";
  assert.equal(namesValue("The slot 2026-02-11 12:00..2026-02-11 12:30 is worse.", label), true, "verbatim");
  assert.equal(namesValue("Wednesday 11 Feb, 12:00-12:30 fell to 54%.", label), true, "reworded");
  assert.equal(namesValue("Wednesday 11 Feb, 12:00 only.", label), false, "a part missing");
  assert.equal(namesValue("Something happened on Wednesday.", label), false);
  assert.equal(namesValue("the 2026-03-11-night shift", "2026-03-11-night"), true);
  assert.equal(namesValue("the night shift on 11 March", "2026-03-11-night"), true, "the date is set aside");
  assert.equal(namesValue("the day shift", "2026-03-11-night"), false);
  assert.equal(namesValue("channel c3", "C3"), true);
  assert.equal(namesValue("channel C4", "C3"), false, "a value with no date part is matched exactly");
});

test("offering the neighbouring periods is not an untraced number, but other figures still are", () => {
  const r = result({ inputs: { metric: "m", period: "2026-W07", baseline: 4 } });
  assert.deepEqual(untracedNumbers("I can rerun for week 6 or 8 to see how long it lasted.", r, "Why did workload rise in week 7?"), []);
  assert.deepEqual(untracedNumbers("I can rerun for week 12.", r, "Why did workload rise in week 7?"), ["12"]);
  // only the period gives neighbours: the baseline length of 4 does not make 5 acceptable
  assert.deepEqual(untracedNumbers("It was 5 weeks.", r, "Why did workload rise in week 7?"), ["5"]);
});

test("runner: findings_include accepts the culprit in any position, and fails when it is missing", () => {
  const two = result({
    findings: [
      { rank: 1, dimension: "d2", value: "Web", impact: -0.011, evidence: ["flat"], effect: "rate" },
      { rank: 2, dimension: "d1", value: "Y", impact: -0.009, evidence: ["refine"], scope: { a2: "P2" }, effect: "rate" },
    ],
  });
  assert.equal(scoreRunner(two, expectation({ top_finding: { dimension: "d1", value: "Y" } })).pass, false, "it is not first");
  assert.equal(scoreRunner(two, expectation({ findings_include: [{ dimension: "d1", value: "Y", scope: { a2: "P2" } }, { dimension: "d2", value: "Web" }] })).pass, true);
  const missing = scoreRunner(two, expectation({ findings_include: [{ dimension: "d1", value: "Z" }] }));
  assert.equal(missing.pass, false);
  assert.match(JSON.stringify(missing.checks), /findings: d2=Web; d1=Y/);
  assert.equal(scoreRunner(two, expectation({ findings_include: [{ dimension: "d1", value: "Y", effect: "mix" }] })).pass, false, "the effect must match too");
});
