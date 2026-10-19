import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { parseScope, ScopedToolCaller } from "../src/scope.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const fault: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 };

async function run(scope: Record<string, string> | null, faults: FaultSpec[] = [fault], metric = "m") {
  const result = await runPlaybook({
    playbook: loadPlaybook("metric_change", "no-such-pack"),
    ontology,
    meta,
    tools: new FakeToolCaller(buildFacts(faults), ontology),
    inputs: { metric, period: "W5", ...(scope ? { scope: JSON.stringify(scope) } : {}) },
  });
  assert.doesNotThrow(() => Result.parse(result));
  return result;
}

test("a run confined to where the fault is still finds it, and to somewhere else finds nothing", async () => {
  const whole = await run(null);
  assert.equal(whole.findings[0].value, "Y");
  const inside = await run({ a2: "P2" });
  assert.equal(inside.status, "complete");
  assert.ok(inside.findings.length > 0 && inside.findings.every((f) => f.value === "Y" || f.value === "P2" || f.scope?.a2 === "P2"), JSON.stringify(inside.findings));
  // the headline is the confined series, not the whole data's: worse inside P2 than overall
  assert.ok(inside.headline!.change < whole.headline!.change);

  const elsewhere = await run({ a2: "Q1" });
  assert.deepEqual(elsewhere.findings, []);
  const otherValue = await run({ d1: "X" });
  assert.deepEqual(otherValue.findings, [], "the fault is in Y, so X is clean");
});

test("two scoped concepts narrow together", async () => {
  const both = await run({ a2: "P2", d1: "Y" });
  assert.equal(both.status, "complete");
  assert.ok(both.headline!.change < -0.2, "everything inside this scope is the fault");
});

test("a scope on a product metric reaches its drivers", async () => {
  const volume: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 9, amountFactor: 3 };
  const inside = await run({ a2: "P2" }, [volume], "volume_x_avg");
  const elsewhere = await run({ a2: "Q2" }, [volume], "volume_x_avg");
  const whole = await run(null, [volume], "volume_x_avg");
  // everything that changed is inside P2, so P2 alone shows the same change; elsewhere nothing changed
  assert.equal(inside.headline!.change, whole.headline!.change);
  assert.equal(elsewhere.headline!.change, 0);
  assert.deepEqual(elsewhere.findings, []);
});

test("a slice by a scoped concept keeps only its row; a drill's narrower filter stands", async () => {
  const seen: Record<string, string>[] = [];
  const inner = { async call(_t: string, p: Record<string, string>) { seen.push(p); return [{ node: "P1" }, { node: "P2" }]; } };
  const sliceByA2 = Object.entries(meta.tools).find(([, m]) => m.kind === "slice" && m.by === "a2" && m.metric === "m")![0];
  const scoped = new ScopedToolCaller(inner, meta, { a2: "P2", d1: "Y" });
  const rows = await scoped.call(sliceByA2, {}, "s");
  assert.deepEqual(rows, [{ node: "P2" }]);
  assert.equal(seen[0].d1, "Y", "the other concept is passed as a filter");
  assert.equal(seen[0].a2, undefined, "the concept being split by is not");
  // series tools take the filter directly
  const series = Object.keys(meta.tools).find((n) => meta.tools[n].kind === "series" && meta.tools[n].metric === "m")!;
  await scoped.call(series, { a2: "P1" }, "s");
  assert.deepEqual(await scoped.call(series, { a2: "P1" }, "s"), [], "a drill into P1 inside a scope of P2 is empty, not widened");
});

test("a concept a tool cannot be confined to is an error, not a wider answer", async () => {
  const scoped = new ScopedToolCaller({ async call() { return []; } }, meta, { nonexistent: "v" });
  const series = Object.keys(meta.tools).find((n) => meta.tools[n].kind === "series")!;
  await assert.rejects(scoped.call(series, {}, "s"), /cannot confine/);
});

test("scope input parsing", () => {
  assert.deepEqual(parseScope(""), {});
  assert.deepEqual(parseScope('{"a":"b","n":3}'), { a: "b", n: "3" });
  assert.throws(() => parseScope("team 5"), /JSON object/);
  assert.throws(() => parseScope("[1]"), /JSON object/);
});
