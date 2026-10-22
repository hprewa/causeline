import { test } from "node:test";
import assert from "node:assert/strict";
import { Exploration } from "@causeline/schema";
import { Explorer, refusalKinds } from "../src/explore.js";
import { ToolIndex } from "../src/toolindex.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const fault: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 3 };
const make = (faults: FaultSpec[] = [fault], extra: Partial<ConstructorParameters<typeof Explorer>[0]> = {}) => new Explorer({ ontology, index: new ToolIndex(meta), tools: new FakeToolCaller(buildFacts(faults)), question: "q", ...extra });

test("a breakdown lists every value with its volume and share, and the shares add up", async () => {
  const s = await make().run({ op: "breakdown", kpi: "m", by: "a2", period: "W5" });
  assert.equal(s.refusal, undefined, s.says);
  assert.deepEqual(s.rows.map((r) => r.node).sort(), ["P1", "P2", "Q1", "Q2"]);
  assert.equal(s.rows.reduce((a, r) => a + (r.volume as number), 0), 4 * 2 * 3 * 7 * 10);
  assert.ok(Math.abs(s.rows.reduce((a, r) => a + (r.share_of_volume as number), 0) - 1) < 1e-6);
  assert.equal(s.rows.find((r) => r.node === "P2")!.value, 0.3, "the planted fault: 3 in 10 ok");
  assert.match(s.says, /m by a2 in W5/);
});

test("a ranking puts the right end first, and by change against another window", async () => {
  const lowest = await make().run({ op: "rank", kpi: "m", by: "a2", period: "W5", order: "lowest", top: 2 });
  assert.deepEqual(lowest.rows.map((r) => [r.rank, r.node]), [[1, "P2"], [2, "P1"]]);
  assert.ok(Math.abs((lowest.rows[0].gap_to_next as number) - ((lowest.rows[1].value as number) - (lowest.rows[0].value as number))) < 1e-6, "how far the first is from the next ranked");
  const highest = await make().run({ op: "rank", kpi: "m", by: "a2", period: "W5", order: "highest", top: 1 });
  assert.notEqual(highest.rows[0].node, "P2");
  const fall = await make().run({ op: "rank", kpi: "m", by: "a2", period: "W5", against_period: "W4", order: "biggest_fall", top: 1 });
  assert.equal(fall.rows[0].node, "P2");
  assert.ok((fall.rows[0].change as number) < -0.5);
  const noWindow = await make().run({ op: "rank", kpi: "m", by: "a2", period: "W5", order: "biggest_fall" });
  assert.equal(noWindow.refusal?.code, "unsupported");
  assert.match(noWindow.refusal!.reason, /second window/);
});

test("a filter confines the rows, and a value that matches nothing says which values exist", async () => {
  const inside = await make().run({ op: "breakdown", kpi: "m", by: "d1", period: "W5", filters: { a2: "P2" } });
  assert.equal(inside.rows.length, 3);
  assert.ok(inside.rows.every((r) => r.value === 0.3));
  const none = await make().run({ op: "breakdown", kpi: "m", by: "d1", period: "W5", filters: { a2: "x'; DROP TABLE facts; --" } });
  assert.equal(none.rows.length, 0);
  assert.match(none.says, /Nothing matched/);
  assert.match(none.says, /a2: .*P1/, "the values that do exist are listed, not guessed");
});

test("groups under the KPI's minimum volume are not ranked, and are listed apart", async () => {
  const strict = { ...ontology, metrics: { ...ontology.metrics, m: { ...ontology.metrics.m, min_volume: 500 } } } as typeof ontology;
  const s = await make([fault], { ontology: strict }).run({ op: "rank", kpi: "m", by: "a2", period: "W5", order: "lowest" });
  assert.equal(s.rows.length, 0);
  assert.match(s.notes.join(" "), /4 a2 values had under 500 rows and were not ranked/);
});

test("a series reads a KPI over time for a range of whole days, for one filter", async () => {
  const s = await make().run({ op: "series", kpi: "m", level: "dy", start_date: "2026-01-29", end_date: "2026-02-04", filters: { a2: "P2" } });
  assert.equal(s.refusal, undefined, s.says);
  assert.equal(s.rows.length, 7);
  assert.ok(s.rows.every((r) => r.value === 0.3));
  const bad = await make().run({ op: "series", kpi: "m", level: "hour", period: "W5" });
  assert.match(bad.refusal!.reason, /not a time level/);
});

test("two values of a concept, or two windows, are compared with whether the difference is real", async () => {
  const nodes = await make().run({ op: "compare", kpi: "m", by: "a2", nodes: ["P1", "P2"], period: "W5" });
  assert.equal(nodes.refusal, undefined, nodes.says);
  assert.equal(nodes.rows.find((r) => r.label === "more than chance explains")!.value, true);
  assert.ok((nodes.rows.find((r) => r.label === "difference")!.value as number) > 0.5);
  const windows = await make().run({ op: "compare", kpi: "m", period: "W5", against_period: "W4" });
  assert.equal(windows.rows.find((r) => r.label === "more than chance explains")!.value, true);
  const same = await make([]).run({ op: "compare", kpi: "m", period: "W5", against_period: "W4" });
  assert.equal(same.rows.find((r) => r.label === "more than chance explains")!.value, false);
  const missing = await make().run({ op: "compare", kpi: "m", by: "a2", nodes: ["P1", "ZZ"], period: "W5" });
  assert.match(missing.refusal!.reason, /ZZ not found/);
});

test("requests outside the closed set are refused with a reason and what to do instead", async () => {
  const e = make();
  const kpi = await e.run({ op: "breakdown", kpi: "nope", by: "a2", period: "W5" });
  assert.equal(kpi.refusal?.code, "unknown_kpi");
  assert.match(kpi.refusal!.instead, /KPIs are: m, n rows/);
  const concept = await e.run({ op: "breakdown", kpi: "m", by: "colour", period: "W5" });
  assert.equal(concept.refusal?.code, "unknown_concept");
  assert.match(concept.refusal!.instead, /a1, a2, b1, d1/);
  const product = await e.run({ op: "breakdown", kpi: "volume_x_avg", by: "a2", period: "W5" });
  assert.match(product.refusal!.reason, /product of n rows and avg amount/);
  assert.match((await e.run({ op: "breakdown", kpi: "m", by: "a2", period: "W99" })).refusal!.reason, /not a wk in the data/);
  assert.match((await e.run({ op: "breakdown", kpi: "m", by: "a2", start_date: "2030-01-01", end_date: "2030-01-07" })).refusal!.reason, /holds no data/);
  assert.match((await e.run({ op: "breakdown", kpi: "m", by: "a2", start_date: "2026-02-04", end_date: "2026-01-29" })).refusal!.reason, /ends .* before it starts/);
  assert.match((await e.run({ op: "breakdown", kpi: "m", by: "a2" })).refusal!.reason, /needs a period/);
  assert.match((await e.run({ op: "breakdown", kpi: "m", by: "a2", period: "W5", filters: { a2: "P1" } })).refusal!.reason, /both what the split is by and a filter/);
  assert.match((await e.run({ op: "profile", kpi: "m", cycle: "lunar", period: "W5" })).refusal!.reason, /no pattern by "lunar"/);
});

test("the standard refusals exist for every kind of request that cannot be done, and are recorded", async () => {
  for (const kind of refusalKinds()) {
    const s = await make().run({ op: "cannot", kind: kind as never, request: "run SELECT * FROM facts" });
    assert.ok(s.refusal && s.refusal.reason.length > 20 && s.refusal.instead.length > 20, kind);
  }
  const sql = await make().run({ op: "cannot", kind: "free_sql" });
  assert.match(sql.refusal!.reason, /Free-form queries are not available/);
  assert.match((await make().run({ op: "cannot", kind: "cause" })).refusal!.instead, /why the KPI changed/);
});

test("the step budget and the row budget end an exploration with a stated reason, and a refusal does not use a step", async () => {
  const e = make([fault], { budget: { steps: 2, rows: 400 } });
  await e.run({ op: "breakdown", kpi: "m", by: "a2", period: "W5" });
  await e.run({ op: "breakdown", kpi: "nope", by: "a2", period: "W5" });
  await e.run({ op: "breakdown", kpi: "m", by: "d1", period: "W5" });
  const third = await e.run({ op: "breakdown", kpi: "m", by: "b1", period: "W5" });
  assert.equal(third.refusal?.code, "budget");
  assert.match(third.refusal!.reason, /used its 2 steps/);
  assert.equal(e.record.stopped?.reason, "budget");
  assert.equal((await e.run({ op: "series", kpi: "m", period: "W5" })).refusal?.code, "budget", "once stopped it stays stopped");

  const r = make([fault], { budget: { steps: 12, rows: 6 } });
  const first = await r.run({ op: "breakdown", kpi: "m", by: "a2", period: "W5" });
  assert.equal(first.rows.length, 4);
  const second = await r.run({ op: "breakdown", kpi: "m", by: "d1", period: "W5" });
  assert.equal(second.rows.length, 2);
  assert.match(second.notes.join(" "), /Only 2 of 3 rows are shown/);
  assert.equal((await r.run({ op: "breakdown", kpi: "m", by: "b1", period: "W5" })).refusal?.code, "budget");
});

test("the record is labelled exploratory, numbers every step, names the KPIs read with their rung, and is a valid stored exploration", async () => {
  const e = make([fault], { rungOf: (k) => (k === "m" ? "reconciled" : "draft") });
  await e.run({ op: "breakdown", kpi: "m", by: "a2", period: "W5" });
  await e.run({ op: "rank", kpi: "m", by: "a2", period: "W5", order: "lowest" });
  const parsed = Exploration.parse(JSON.parse(JSON.stringify(e.record)));
  assert.equal(parsed.label, "exploratory");
  assert.deepEqual(parsed.steps.map((s) => s.n), [1, 2]);
  assert.deepEqual(parsed.kpis, [{ kpi: "m", rung: "reconciled" }]);
  assert.equal(parsed.question, "q");
  assert.deepEqual(parsed.budget, { steps: 2, max_steps: 12, rows: 8, max_rows: 400 });
  assert.match(parsed.steps[0].asked, /m by a2/);
});
