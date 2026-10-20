import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseStream } from "../src/agent.js";
import { loadCases } from "../src/cases.js";
import { renderTable, type CaseOutcome } from "../src/table.js";

const resultJson = {
  playbook: "metric_change",
  inputs: { metric: "m", period: "W5" },
  status: "complete",
  headline: { metric: "m", value: 0.9, baseline: 0.93, change: -0.03 },
  findings: [{ rank: 1, dimension: "d1", value: "Y", impact: -0.03, evidence: [] }],
  generator: { name: "causeline", version: "0.1.0", url: "https://example.com/x" },
};

const line = (o: unknown) => JSON.stringify(o);

test("parseStream pulls tool calls, the playbook result, narrative and metrics out of stream-json", () => {
  const lines = [
    line({ type: "system", subtype: "init", mcp_servers: [{ name: "causeline-mcp", status: "connected" }] }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t1", name: "mcp__plugin_causeline_causeline-mcp__list_playbooks", input: {} }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "{}" }] }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__plugin_causeline_causeline-mcp__run_playbook", input: { name: "metric_change", inputs: { metric: "m", period: "W5" } } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: JSON.stringify({ file: "runs/x.json", result: resultJson }) }] }] } }),
    "not json at all",
    line({ type: "result", subtype: "success", result: "It was d1 Y.", total_cost_usd: 0.123, num_turns: 3, duration_ms: 4500, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400 } }),
  ];
  const run = parseStream(lines);
  assert.equal(run.narrative, "It was d1 Y.");
  assert.deepEqual(run.toolCalls.map((t) => t.name.split("__").pop()), ["list_playbooks", "run_playbook"]);
  assert.equal(run.result?.findings[0].value, "Y");
  assert.deepEqual(run.metrics, { turns: 3, inputTokens: 500, outputTokens: 50, costUsd: 0.123, ms: 4500 });
  assert.equal(run.error, undefined);
  assert.ok(run.session);
});

test("parseStream also accepts a bare result in the tool output", () => {
  const lines = [
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__x__run_playbook", input: { name: "metric_change" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify(resultJson) }] } }),
    line({ type: "result", subtype: "success", result: "ok" }),
  ];
  assert.equal(parseStream(lines).result?.findings[0].value, "Y");
});

test("parseStream only trusts the result of a run_playbook call, and flags a failed run", () => {
  const lines = [
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__x__other_tool", input: {} }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify(resultJson) }] } }),
    line({ type: "result", subtype: "error_max_turns", result: "ran out of turns" }),
  ];
  const run = parseStream(lines);
  assert.equal(run.result, null);
  assert.match(run.error!, /error_max_turns/);
});

test("renderTable shows scores, totals and the failing checks", () => {
  const outcomes: CaseOutcome[] = [
    { id: "good", runner: { pass: true, checks: [{ name: "x", ok: true }] }, runnerMs: 100, steps: 5 },
    { id: "bad", runner: { pass: false, checks: [{ name: "top_finding", ok: false, detail: "expected a=b, got c=d" }] }, runnerMs: 200, steps: 6 },
    { id: "broken", runner: { error: "toolbox did not start" }, runnerMs: 0, steps: 0 },
  ];
  const text = renderTable(outcomes, false);
  assert.match(text, /good\s+pass/);
  assert.match(text, /bad\s+FAIL/);
  assert.match(text, /broken\s+ERROR/);
  assert.match(text, /runner score: 1\/3/);
  assert.match(text, /bad \[runner\] top_finding: expected a=b, got c=d/);
  assert.match(text, /broken \[runner\] ERROR: toolbox did not start/);
});

test("renderTable adds agent columns when an agent ran", () => {
  const outcomes: CaseOutcome[] = [
    {
      id: "c",
      runner: { pass: true, checks: [] },
      runnerMs: 1,
      steps: 1,
      agent: { pass: true, checks: [], metrics: { turns: 4, inputTokens: 900, outputTokens: 100, costUsd: 0.0421, ms: 12300 } },
    },
  ];
  const text = renderTable(outcomes, true);
  assert.match(text, /agent score:  1\/1/);
  assert.match(text, /1000/);
  assert.match(text, /0\.042/);
});

test("the contact-centre pack's eval cases load, and a case filter is validated", () => {
  const pack = resolve("..", "..", "packs", "contact-centre");
  const all = loadCases(pack);
  assert.equal(all.length, 22, "18 that pass, 2 depth cases that pass today and must keep passing, and 2 marked as known gaps until fixed");
  assert.equal(new Set(all.map((c) => c.id)).size, 22);
  assert.equal(all.filter((c) => c.gap).length, 2);
  assert.ok(all.every((c) => c.inputs), "every case can be run at runner level");
  assert.deepEqual(loadCases(pack, ["clean_week"]).map((c) => c.id), ["clean_week"]);
  assert.throws(() => loadCases(pack, ["nope"]), /no such eval case/);
});
