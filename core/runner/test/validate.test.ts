import { test } from "node:test";
import assert from "node:assert/strict";
import { Playbook } from "@causeline/schema";
import { checkPlaybook } from "../src/validate.js";
import { loadPlaybook } from "../src/load.js";

const make = (steps: object[]) => Playbook.parse({ name: "p", description: "d", steps });
const s = (id: string, compute: string, extra: object = {}) => ({ id, compute, ...extra });

test("the shipped playbooks are sound", () => {
  for (const name of ["metric_change", "value", "trend", "compare"]) assert.deepEqual(checkPlaybook(loadPlaybook(name, "no-such-pack")), [], name);
});

test("a condition may read only facts an earlier step publishes", () => {
  const ok = make([s("h", "change_vs_baseline"), s("w", "guided_drill", { when: 'h.direction == "down"' })]);
  assert.deepEqual(checkPlaybook(ok), []);
  assert.match(checkPlaybook(make([s("h", "change_vs_baseline"), s("w", "guided_drill", { when: "h.nope == 1" })])).join(), /publishes only/);
  assert.match(checkPlaybook(make([s("w", "guided_drill", { when: "h.significant" }), s("h", "change_vs_baseline")])).join(), /later step/);
  assert.match(checkPlaybook(make([s("w", "guided_drill", { when: "zz.significant" })])).join(), /no step "zz"/);
});

test("a rule that sends the run back needs max_visits on the target", () => {
  const loop = (extra: object) => make([s("a", "rank_dimensions", extra), s("b", "persistence", { next: [{ if: "a.found > 0", then: "a" }, { else: "c" }] }), s("c", "evidence")]);
  assert.match(checkPlaybook(loop({})).join(), /max_visits/);
  assert.deepEqual(checkPlaybook(loop({ max_visits: 2 })), []);
});

test("a step no rule can reach is reported", () => {
  const p = make([s("a", "rank_dimensions", { next: [{ else: "c" }] }), s("b", "persistence"), s("c", "evidence")]);
  assert.deepEqual(checkPlaybook(p), ['step "b" can never run']);
});
