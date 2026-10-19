import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { buildFacts, FakeToolCaller, meta, ontology, seasonalMeta, seasonalOntology, type FaultSpec } from "./fake.js";

// The fixture's weeks are blocks of seven days starting on 2026-01-01 (a Thursday): week w, day d is 2026-01-01 + 7(w-1) + (d-1).
const date = (week: number, day: number) => new Date(Date.UTC(2026, 0, 1 + (week - 1) * 7 + (day - 1))).toISOString().slice(0, 10);

const playbook = (name = "metric_change") => loadPlaybook(name, "no-such-pack");

async function run(inputs: Record<string, string | number>, faults: FaultSpec[] = [], opts: { seasonal?: boolean; playbook?: string } = {}) {
  const ont = opts.seasonal ? seasonalOntology : ontology;
  const result = await runPlaybook({
    playbook: playbook(opts.playbook),
    ontology: ont,
    meta: opts.seasonal ? seasonalMeta : meta,
    tools: new FakeToolCaller(buildFacts(faults), ont),
    inputs: { metric: "m", ...inputs },
  });
  assert.doesNotThrow(() => Result.parse(result));
  return result;
}

const fault: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 };
const summary = (r: Awaited<ReturnType<typeof run>>) => ({
  status: r.status,
  headline: r.headline && { value: r.headline.value, baseline: r.headline.baseline, change: r.headline.change, z: r.headline.z },
  findings: r.findings.map((f) => [f.dimension, f.value, f.scope ?? null, f.impact]),
  flags: r.masking_flags.map((m) => [m.type, m.level]),
  path: r.path.map((p) => [p.level, p.node, p.decision]),
});

test("a range that is exactly one period gives the same answer as that period's label", async () => {
  const byLabel = await run({ period: "W5" }, [fault]);
  const byRange = await run({ start_date: date(5, 1), end_date: date(5, 7) }, [fault]);
  assert.equal(byRange.status, "complete");
  assert.equal(byRange.findings[0].value, "Y", "the planted fault is found");
  assert.deepEqual(summary(byRange), summary(byLabel));
});

test("the same holds for a total, and for a product that is analysed through its drivers", async () => {
  const volume: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2", okOutOf10: 9, amountFactor: 3 };
  for (const metric of ["total_amount", "volume_x_avg"]) {
    const byLabel = await run({ metric, period: "W5" }, [volume]);
    const byRange = await run({ metric, start_date: date(5, 1), end_date: date(5, 7) }, [volume]);
    assert.deepEqual(summary(byRange), summary(byLabel), metric);
  }
});

test("a range of several periods is compared with earlier windows of the same length", async () => {
  const r = await run({ start_date: date(4, 1), end_date: date(5, 7) }, [fault]);
  assert.equal(r.status, "complete");
  assert.equal(r.findings[0].value, "Y");
  assert.deepEqual(r.findings[0].scope, { a2: "P2" });
  assert.ok(r.seasonality?.notes.some((n) => n.includes(`${date(4, 1)}..${date(5, 7)}`) && /14 days/.test(n)), "the window and its length are stated");
});

test("with a weekly cycle, one day is compared with the same weekday in earlier weeks, not with the days before it", async () => {
  // the last two days of every week are always worse: a pattern, not a fault
  const weekend: FaultSpec = { where: (f) => f.day >= 6, okOutOf10: 6 };
  const quietDay = await run({ start_date: date(5, 6), end_date: date(5, 6) }, [weekend], { seasonal: true });
  assert.equal(quietDay.status, "complete");
  assert.deepEqual(quietDay.findings, [], "a usual bad day is not a finding");
  assert.ok(quietDay.seasonality?.notes.some((n) => /a week apart/.test(n)));

  // without the cycle the same day looks like a collapse against the ordinary days before it
  const naive = await run({ start_date: date(5, 6), end_date: date(5, 6) }, [weekend]);
  assert.ok(naive.findings.length > 0 || naive.masking_flags.length > 0 || naive.headline!.significant);

  // a genuinely bad day is found, and only that node
  const real: FaultSpec = { where: (f) => f.week === 5 && f.day === 3 && f.a2 === "P2", okOutOf10: 2 };
  const bad = await run({ start_date: date(5, 3), end_date: date(5, 3) }, [real], { seasonal: true });
  assert.equal(bad.findings[0].value, "P2");
});

test("a few weekdays of a week are compared with the same weekdays, in the node queries too", async () => {
  const weekend: FaultSpec = { where: (f) => f.day >= 6, okOutOf10: 6 };
  const r = await run({ start_date: date(5, 5), end_date: date(5, 7) }, [weekend], { seasonal: true });
  assert.deepEqual(r.findings, [], "days 5 to 7 are compared with days 5 to 7 of earlier weeks, so nothing is different");
  assert.deepEqual(r.masking_flags, []);
});

test("a range the data cannot answer stops and says why, instead of guessing", async () => {
  const outside = await run({ start_date: "2025-12-01", end_date: "2025-12-31" });
  assert.equal(outside.status, "stopped");
  assert.equal(outside.stopped_reason, "period_not_found");
  assert.match(outside.stopped_detail!, /covers 2026-01-01 to 2026-02-11/);

  const backwards = await run({ start_date: "2026-02-05", end_date: "2026-02-01" });
  assert.equal(backwards.stopped_reason, "bad_range");
  assert.match(backwards.stopped_detail!, /ends \(2026-02-01\) before it starts/);

  const malformed = await run({ start_date: "last week", end_date: "yesterday" });
  assert.equal(malformed.stopped_reason, "bad_range");

  const half = await run({ start_date: date(5, 1) });
  assert.equal(half.stopped_reason, "bad_range", "one end of a range is not a range");

  const first = await run({ start_date: date(1, 1), end_date: date(1, 7) });
  assert.equal(first.stopped_reason, "no_baseline", "the first window has nothing earlier to compare with");
});

test("two periods are compared by label; a range there is refused clearly", async () => {
  const r = await run({ start_date: date(5, 1), end_date: date(5, 7), against: "W4" }, [], { playbook: "compare" });
  assert.equal(r.status, "stopped");
  assert.match(r.stopped_detail!, /takes period labels/);
});

test("an aggregation that is not a level of the ontology changes nothing", async () => {
  const plain = await run({ start_date: date(5, 1), end_date: date(5, 7) }, [fault]);
  const odd = await run({ start_date: date(5, 1), end_date: date(5, 7), aggregation: "fortnight" }, [fault]);
  assert.deepEqual(summary(odd), summary(plain));
});
