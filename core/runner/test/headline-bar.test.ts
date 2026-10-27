import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlaybook } from "../src/load.js";
import { headlineBar } from "../src/masking.js";
import { runPlaybook } from "../src/runner.js";
import { normInv, tCdf, tInv } from "../src/stats.js";
import { buildFacts, FakeToolCaller, meta, ontology } from "./fake.js";

const near = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("the Student t quantile matches the standard tables, and becomes the normal one as the degrees of freedom grow", () => {
  near(tInv(0.975, 10), 2.2281, 1e-3);
  near(tInv(0.995, 11), 3.1058, 1e-3);
  near(tInv(0.995, 4), 4.6041, 1e-3);
  near(tInv(0.9995, 11), 4.4370, 2e-3);
  near(tInv(0.975, 1e7), normInv(0.975), 1e-6);
  near(tInv(0.975, Infinity), 1.95996, 1e-4);
  near(tInv(0.025, 10), -2.2281, 1e-3);
  assert.equal(tInv(0.5, 7), 0);
  near(tCdf(2.2281, 10), 0.975, 1e-4);
  assert.throws(() => tInv(1, 5), /p must be in/);
});

test("the headline bar follows the alarm budget and how well the data's own movement is known", () => {
  near(headlineBar(0.05, 0), 2.5758, 1e-3); // nothing estimated: the normal quantile at a level of 0.01
  near(headlineBar(0.05, 4), 2.5758, 1e-3); // too little history to estimate it: the same
  near(headlineBar(0.05, 12), 3.1058, 1e-3); // 11 degrees of freedom
  near(headlineBar(0.05, 5), 4.6041, 1e-3); // a spread learned from five periods is a weak one
  assert.ok(headlineBar(0.05, 12) > headlineBar(0.05, 26), "more history, a lower bar");
  assert.ok(headlineBar(0.1, 12) < headlineBar(0.05, 12), "a larger budget, a lower bar");
});

/** A change of about 2.9 standard errors in a week with twelve earlier weeks to learn the data's own movement from. */
const faults = [{ where: (f: { a2: string; b1: string; week: number }) => (f.a2 === "P1" || f.a2 === "P2") && f.b1 === "U" && f.week === 13, okOutOf10: 8 }];
const playbook = loadPlaybook("metric_change", "no-such-pack");
const run = (extra: Record<string, number> = {}) => runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(faults, 14)), inputs: { metric: "m", period: "W13", ...extra } });

test("the headline bar follows the alarm budget only when a pack or run sets one; naming parent_z always wins", async () => {
  const fixed = await run();
  const z = Math.abs(fixed.headline!.z!);
  assert.ok(z > 2.5 && z < 3.1, `the planted change is about 2.9 standard errors, got ${z}`);
  assert.equal(fixed.headline!.significant, true, "by default the bar is the fixed threshold of 2, as it always was");
  const budgeted = await run({ alarm_budget: 0.05 });
  assert.equal(budgeted.headline!.significant, false, "with a budget of one in twenty and twelve earlier periods the bar is about 3.1");
  const generous = await run({ alarm_budget: 0.2 });
  assert.equal(generous.headline!.significant, true, "a bigger budget lowers the bar (2.7)");
  const named = await run({ alarm_budget: 0.05, parent_z: 2 });
  assert.equal(named.headline!.significant, true, "a pack or run that names parent_z gets exactly what it named");
});
