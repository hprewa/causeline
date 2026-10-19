import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { RunStop, type ToolCaller, type Row } from "../src/types.js";
import { buildFacts, FakeToolCaller, meta, ontology } from "./fake.js";

/** A caller that counts what it is asked, reports a cost, and refuses once a limit of calls is reached. */
class MeteredFake implements ToolCaller {
  calls = 0;
  private readonly inner = new FakeToolCaller(buildFacts());
  constructor(private readonly limit: number) {}
  async call(tool: string, params: Record<string, string>): Promise<Row[]> {
    if (this.calls >= this.limit) throw new RunStop("cost_budget", "This question would read more data than the limit allows, so it was stopped.");
    this.calls++;
    return this.inner.call(tool, params);
  }
  cost() {
    return { queries: this.calls, bytes_scanned: this.calls * 1000, estimated_usd: 0, budget_bytes: this.limit * 1000 };
  }
}

const playbook = loadPlaybook("metric_change", "no-such-pack");
const run = (tools: ToolCaller, metric = "m") => runPlaybook({ playbook, ontology, meta, tools, inputs: { metric, period: "W5" } });

test("a run reports what it cost when the tool caller can say", async () => {
  const tools = new MeteredFake(10_000);
  const r = await run(tools);
  assert.equal(r.status, "complete");
  assert.equal(r.cost!.queries, tools.calls);
  assert.equal(r.cost!.bytes_scanned, tools.calls * 1000);
  assert.doesNotThrow(() => Result.parse(r));
});

test("a caller that stops the run ends it cleanly with its reason, and the result still says what was spent", async () => {
  const r = await run(new MeteredFake(3));
  assert.equal(r.status, "stopped");
  assert.equal(r.stopped_reason, "cost_budget");
  assert.match(r.stopped_detail!, /limit/);
  assert.deepEqual(r.findings, []);
  assert.equal(r.cost!.queries, 3);
});

test("the same holds for a product metric, which drills through its drivers", async () => {
  const r = await run(new MeteredFake(2), "volume_x_avg");
  assert.equal(r.status, "stopped");
  assert.equal(r.stopped_reason, "cost_budget");
  assert.equal(r.cost!.queries, 2);
});

test("a caller with no cost reports none", async () => {
  const r = await run(new FakeToolCaller(buildFacts()));
  assert.equal(r.cost, undefined);
});
