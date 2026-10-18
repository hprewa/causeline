import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { EvalCases } from "../src/evalcase.js";

// The build spec's two eval case examples, verbatim.
const EVAL_CASES_YAML = `
- id: channel_late_site02
  setup: "--fault channel_late:C3:site_02:wk9-10"
  question: "Why did success rate drop in week 10?"
  expect:
    top_finding: { dimension: channel, value: C3 }
    must_mention: [site_02]
    must_not_claim: [shortage]
- id: missing_scans_site04
  setup: "--fault missing_scans:site_04:wk11"
  question: "success rate looks terrible at site 4 in week 11 - what happened?"
  expect:
    stopped_reason: data_quality
`;

test("spec's eval cases parse", () => {
  const parsed = EvalCases.parse(parseYaml(EVAL_CASES_YAML));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].expect.top_finding?.value, "C3");
  assert.equal(parsed[1].expect.stopped_reason, "data_quality");
});

test("rejects an eval case whose expect asserts nothing", () => {
  const cases = parseYaml(EVAL_CASES_YAML);
  cases[0].expect = {};
  assert.throws(() => EvalCases.parse(cases));
});

test("cases may carry runner inputs and the masking-era expectations", () => {
  const parsed = EvalCases.parse([
    {
      id: "masked",
      setup: "--fault offset:region=R1:region=R2:wk8",
      question: "Is something hiding?",
      inputs: { metric: "success_rate", period: "2026-W08" },
      expect: { masking_flags: ["offsetting"], top_finding: { dimension: "region", value: "R1", scope: { network: "N1" }, effect: "rate" } },
    },
    { id: "clean", setup: "--seed 42", question: "Anything unusual?", expect: { no_findings: true } },
  ]);
  assert.equal(parsed[0].inputs?.playbook, "metric_change", "playbook defaults to metric_change");
  assert.equal(parsed[0].expect.top_finding?.effect, "rate");
  assert.equal(parsed[1].inputs, undefined);
});

test("no_findings: false or an empty masking_flags list asserts nothing", () => {
  const base = { id: "x", setup: "s", question: "q" };
  assert.throws(() => EvalCases.parse([{ ...base, expect: { no_findings: false } }]));
  assert.throws(() => EvalCases.parse([{ ...base, expect: { masking_flags: [] } }]));
  assert.throws(() => EvalCases.parse([{ ...base, expect: { masking_flags: ["not_a_flag"] } }]));
});
