import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { Playbook } from "../src/playbook.js";

// The build spec's metric_change.yaml, verbatim.
const METRIC_CHANGE_YAML = `
name: metric_change
description: Find where and when a metric changed, using the pack's ontology.
inputs:
  metric:   { type: string }
  period:   { type: string }
  baseline: { type: int, default: 4 }
steps:
  - id: data_check
    compute: coverage_and_counts
  - id: headline
    compute: change_vs_baseline
  - id: when
    compute: guided_drill
    over: time
  - id: where
    compute: guided_drill
    over: hierarchies
    within: when
  - id: flat
    compute: rank_dimensions
    within: when
  - id: cross_check
    compute: persistence
output: result.json
`;

test("metric_change playbook parses", () => {
  const parsed = Playbook.parse(parseYaml(METRIC_CHANGE_YAML));
  assert.equal(parsed.name, "metric_change");
  assert.equal(parsed.steps.length, 6);
  assert.equal(parsed.inputs.baseline.default, 4);
});

test("rejects a step whose within refers to a later or unknown step id", () => {
  const bad = parseYaml(METRIC_CHANGE_YAML);
  bad.steps[0].within = "cross_check"; // later step
  assert.throws(() => Playbook.parse(bad));

  const bad2 = parseYaml(METRIC_CHANGE_YAML);
  bad2.steps[3].within = "does_not_exist";
  assert.throws(() => Playbook.parse(bad2));
});

test("rejects duplicate step ids", () => {
  const bad = parseYaml(METRIC_CHANGE_YAML);
  bad.steps[1].id = "data_check";
  assert.throws(() => Playbook.parse(bad));
});

test("defaults output to result.json when omitted", () => {
  const withoutOutput = parseYaml(METRIC_CHANGE_YAML);
  delete withoutOutput.output;
  const parsed = Playbook.parse(withoutOutput);
  assert.equal(parsed.output, "result.json");
});
