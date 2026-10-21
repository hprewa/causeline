import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import type { RunContext } from "../src/context.js";
import { handOver, handOverToParts } from "../src/handoff.js";

const result = (significant: boolean) => Result.parse({ playbook: "p", inputs: {}, status: "complete", headline: { metric: "b", kind: "sum", format: "number", value: 2, baseline: 1, change: 1, z: 5, significant }, findings: [], generator: { name: "t", version: "0", url: "https://example.org" } });

function ctx(extra: Partial<RunContext> = {}): RunContext {
  return { metric: "a", ontology: { metrics: { a: { children: ["b", "gone", "a"] }, b: {} } }, handoffs: [], notes: [], ...extra } as unknown as RunContext;
}

test("a hand-over keeps a short account of the other KPI's analysis", async () => {
  const asked: string[] = [];
  const c = ctx({ analyse: async (m) => (asked.push(m), result(true)) });
  await handOver(c, ["b"], "because");
  assert.deepEqual(asked, ["b"]);
  assert.equal(c.handoffs[0].metric, "b");
  assert.equal(c.handoffs[0].reason, "because");
  assert.equal(c.handoffs[0].headline?.significant, true);
});

test("the KPI's own parts are handed over to; an unknown KPI and the KPI itself are not", async () => {
  const asked: string[] = [];
  const c = ctx({ analyse: async (m) => (asked.push(m), result(false)) });
  await handOverToParts(c);
  assert.deepEqual(asked, ["b"]);
  assert.match(c.notes.join(), /"gone" not made: it is not a KPI of this pack/);
});

test("with the chain as long as it may be, nothing is analysed and the step says so", async () => {
  const c = ctx();
  await handOver(c, ["b"], "x");
  assert.deepEqual(c.handoffs, []);
  assert.match(c.notes.join(), /as long as it may be/);
});
