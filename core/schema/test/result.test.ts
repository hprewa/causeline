import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "../src/result.js";

// The build spec's result.json example, plus `generator` (required here;
// see the attribution section of the spec — generator metadata is on by
// default, not an afterthought).
const RESULT_JSON = {
  playbook: "success_rate_drop",
  inputs: { week: "2026-W10", baseline_weeks: 4 },
  status: "complete",
  headline: { metric: "success_rate", value: 0.86, baseline: 0.93, change: -0.07 },
  findings: [
    {
      rank: 1,
      dimension: "channel",
      value: "C3",
      impact: -0.051,
      evidence: ["drill", "confirm"],
    },
  ],
  steps: [{ id: "trend", tool: "success_rate_weekly", params: {}, rows: 5, ms: 42 }],
  stopped_reason: null,
  narrative: "Filled in by the LLM after the run.",
  generator: { name: "causeline", version: "0.1.0", url: "https://github.com/example/causeline" },
};

test("spec's result.json example parses with generator added", () => {
  const parsed = Result.parse(RESULT_JSON);
  assert.equal(parsed.findings[0].dimension, "channel");
  assert.equal(parsed.generator.name, "causeline");
  assert.deepEqual(parsed.path, []); // defaults to empty when the run didn't report a drill path
  assert.deepEqual(parsed.masking_flags, []);
});

test("rejects a result missing generator", () => {
  const { generator, ...withoutGenerator } = RESULT_JSON;
  assert.throws(() => Result.parse(withoutGenerator));
});

test("accepts a stopped run with a null headline", () => {
  const stopped = {
    ...RESULT_JSON,
    status: "stopped",
    headline: null,
    findings: [],
    stopped_reason: "data_quality",
    narrative: null,
  };
  const parsed = Result.parse(stopped);
  assert.equal(parsed.status, "stopped");
  assert.equal(parsed.headline, null);
});

test("accepts path and masking_flags entries", () => {
  const withPath = {
    ...RESULT_JSON,
    path: [{ level: "site", node: "site_02", decision: "drill", numbers: { impact: -0.05 } }],
    masking_flags: [{ level: "region", type: "offsetting", detail: "children cancel out" }],
  };
  const parsed = Result.parse(withPath);
  assert.equal(parsed.path[0].decision, "drill");
  assert.equal(parsed.masking_flags[0].type, "offsetting");
});
