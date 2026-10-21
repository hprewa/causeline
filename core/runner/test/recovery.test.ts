import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const playbook = loadPlaybook("metric_change", "no-such-pack");
const bad = (weeks: number[]): FaultSpec => ({ where: (f) => weeks.includes(f.week) && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 });
const run = (faults: FaultSpec[], period: string) => runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(faults, 8)), inputs: { metric: "m", period } });

test("a culprit that is normal again in the periods after is reported as recovered", async () => {
  const r = await run([bad([3])], "W3");
  const f = r.findings.find((x) => x.value === "Y" || x.value === "P2")!;
  assert.equal(f.after?.status, "recovered");
  assert.ok(f.after!.periods >= 3);
});

test("a culprit still off in the newest period after is reported as ongoing", async () => {
  const r = await run([bad([3, 4, 5, 6, 7, 8])], "W3");
  assert.ok(r.findings.length > 0);
  assert.ok(r.findings.every((f) => !f.after || f.after.status === "ongoing"));
  assert.ok(r.findings.some((f) => f.after?.status === "ongoing"));
});

test("nothing is said about the periods after when the period asked about is the newest", async () => {
  const r = await run([bad([8])], "W8");
  assert.ok(r.findings.length > 0);
  assert.ok(r.findings.every((f) => f.after === undefined));
});
