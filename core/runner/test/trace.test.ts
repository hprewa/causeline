import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { FACTS } from "../src/facts.js";
import { COMPUTE } from "../src/steps.js";
import { buildFacts, FakeToolCaller, meta, ontology } from "./fake.js";

const playbook = loadPlaybook("metric_change", "no-such-pack");
const run = (faults: Parameters<typeof buildFacts>[0], period: string) => runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(faults)), inputs: { metric: "m", period } });

test("every step run is in the trace, in order, with the facts it published", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 }], "W5");
  assert.deepEqual(r.trace.map((t) => t.step), playbook.steps.map((s) => s.id));
  const headline = r.trace.find((t) => t.step === "headline")!;
  assert.equal(headline.facts.significant, true);
  assert.equal(headline.facts.direction, "down");
  assert.ok((r.trace.find((t) => t.step === "where")!.facts.found as number) > 0);
});

test("a run that stops ends its trace at the step that stopped it", async () => {
  const r = await runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts([])), inputs: { metric: "m", period: "W99" } });
  assert.equal(r.status, "stopped");
  assert.equal(r.trace.at(-1)!.step, "data_check");
});

test("the facts a step may publish are declared for every compute step", () => {
  for (const name of Object.keys(COMPUTE)) assert.ok(FACTS[name], `${name} declares its facts`);
});
