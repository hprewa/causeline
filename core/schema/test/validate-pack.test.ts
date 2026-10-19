import { test } from "node:test";
import assert from "node:assert/strict";
import { DataDefs, EvidenceSource } from "../src/data.js";
import { findEvidence, findSeries, findSlice, ToolsMeta } from "../src/meta.js";
import { Ontology } from "../src/ontology.js";
import { Playbook } from "../src/playbook.js";
import { validatePack } from "../src/validate-pack.js";

const ontology = (over: Record<string, unknown> = {}) =>
  Ontology.parse({
    time: { levels: ["week", "day", "shift"], seasonality: { cycles: ["weekday"], calendar: ["is_holiday"] } },
    hierarchies: { h1: ["a1", "a2"] },
    dimensions: ["d1"],
    metrics: {
      m: { type: "ratio", direction: "higher_is_better", min_volume: 50 },
      total: { type: "sum", direction: "lower_is_better", min_volume: 50 },
      work: { type: "product", drivers: ["total", "m"], direction: "lower_is_better" },
    },
    ...over,
  });

const data = (over: Record<string, unknown> = {}) =>
  DataDefs.parse({
    source: "src",
    facts: {
      events: {
        sql: "SELECT e.ts, e.a1, p.a2, e.d1, e.ok, e.amount, e.is_holiday FROM events e JOIN parts p USING (part)",
        time: "ts",
        concepts: ["a1", "a2", "d1"],
        time_levels: { shift: "strftime('%Y-%m-%d', ts) || '-x'" },
      },
    },
    metrics: { m: { fact: "events", numerator: "ok" }, total: { fact: "events", value: "amount" } },
    evidence: { incidents: { sql: "SELECT a1, ts, kind FROM incidents", time: "ts", about: ["a1"] } },
    ...over,
  });

const check = (o = ontology(), d = data(), extra: object = {}) => validatePack({ ontology: o, data: d, ...extra });

test("a coherent pack has no errors; a missing min_volume is only a warning", () => {
  assert.deepEqual(check().errors, []);
  assert.match(check(ontology({ metrics: { m: { type: "ratio", direction: "higher_is_better" } } })).warnings.join(), /no min_volume/);
});

test("a ratio's denominator defaults to 1", () => {
  const f = data().metrics.m;
  assert.equal("denominator" in f && f.denominator, "1");
});

test("a metric without a formula, or over an unknown fact, is named in plain words", () => {
  const noFormula = check(ontology(), data({ metrics: { m: { fact: "events", numerator: "ok" } } }));
  assert.match(noFormula.errors.join(), /data\.yaml: metric "total" is in the ontology but has no formula/);
  const badFact = check(ontology(), data({ metrics: { m: { fact: "nope", numerator: "ok" }, total: { fact: "events", value: "amount" } } }));
  assert.match(badFact.errors.join(), /fact "nope", which is not defined/);
});

test("a ratio needs a numerator and a sum needs a value", () => {
  const swapped = check(ontology(), data({ metrics: { m: { fact: "events", value: "ok" }, total: { fact: "events", numerator: "amount" } } }));
  assert.match(swapped.errors.join("|"), /"m" is a ratio.*numerator and denominator/);
  assert.match(swapped.errors.join("|"), /"total" is a sum.*needs a value/);
});

test("every fact must carry every concept the ontology names", () => {
  const r = check(ontology({ dimensions: ["d1", "d2"] }));
  assert.match(r.errors.join(), /fact "events" \(used by "m"\) has no column for "d2"/);
});

test("a time level that is not built in needs its SQL in data.yaml; so does a custom cycle", () => {
  const noShift = check(ontology(), data({ facts: { events: { sql: "SELECT 1", time: "ts", concepts: ["a1", "a2", "d1"] } } }));
  assert.match(noShift.errors.join(), /time level "shift" is not built in/);
  const custom = check(ontology({ time: { levels: ["week", "day", "shift"], seasonality: { cycles: ["pay_week"] } } }));
  assert.match(custom.errors.join(), /cycle "pay_week" is not built in/);
  const defined = data();
  defined.facts.events.slots = { pay_week: { expr: "strftime('%d', ts) / 7", instance: "date(ts)", cycle_days: 30 } };
  assert.deepEqual(check(ontology({ time: { levels: ["week", "day", "shift"], seasonality: { cycles: ["pay_week"] } } }), defined).errors, []);
});

test("a name used by two things is an error", () => {
  assert.match(check(ontology({ dimensions: ["a1"] })).errors.join(), /"a1" is used by hierarchy "h1" and the dimensions list/);
  assert.match(check(ontology({ hierarchies: { h1: ["day", "a2"] } })).errors.join(), /"day"/);
});

test("product drivers must resolve; a product has no formula of its own", () => {
  const unresolved = check(ontology({ metrics: { m: { type: "ratio", direction: "higher_is_better", min_volume: 1 }, work: { type: "product", drivers: ["m", "ghost"], direction: "lower_is_better" } } }));
  assert.match(unresolved.errors.join(), /driver "ghost", which is not a metric/);
  const formula = data();
  (formula.metrics as Record<string, unknown>).work = { fact: "events", value: "1" };
  assert.match(check(ontology(), formula).errors.join(), /"work" is a product/);
});

test("evidence must be about known concepts, and a playbook can only use evidence that is defined", () => {
  const badAbout = check(ontology(), data({ evidence: { incidents: EvidenceSource.parse({ sql: "SELECT 1", time: "ts", about: ["planet"] }) } }));
  assert.match(badAbout.errors.join(), /evidence "incidents" is about "planet"/);
  const pb = Playbook.parse({ name: "p", description: "d", steps: [{ id: "a", compute: "coverage_and_counts" }, { id: "why", evidence: "weather" }] });
  assert.match(check(ontology(), data(), { playbooks: [pb] }).errors.join(), /step "why": evidence "weather" is not defined/);
});

test("a playbook step is either compute or evidence, not both and not neither", () => {
  assert.throws(() => Playbook.parse({ name: "p", description: "d", steps: [{ id: "a", compute: "x", evidence: "y" }] }));
  assert.throws(() => Playbook.parse({ name: "p", description: "d", steps: [{ id: "a" }] }));
});

test("generated tools are checked against what the runner will ask for", () => {
  const meta = ToolsMeta.parse({
    tools: {
      m_series: { kind: "series", metric: "m", levels: ["week"] },
      m_by_a1: { kind: "slice", metric: "m", by: "a1" },
      incidents: { kind: "evidence", evidence: "incidents", about: ["a1"] },
    },
  });
  const r = check(ontology(), data(), { meta });
  assert.match(r.errors.join("\n"), /tools: no tool provides the day series for "m"/);
  assert.match(r.errors.join("\n"), /a split by a2 within a1 for "m"/);
  assert.match(r.errors.join("\n"), /a split by d1 for "total"/);
  assert.ok(!/evidence "incidents"/.test(r.errors.join("\n")));
});

test("tools are found by what they answer, not by name", () => {
  const meta = ToolsMeta.parse({
    tools: {
      weird_name_1: { kind: "slice", metric: "m", by: "a2", filters: ["a1", "d1"] },
      weird_name_2: { kind: "series", metric: "m", levels: ["day", "week"], filters: ["d1"] },
      weird_name_3: { kind: "evidence", evidence: "incidents", about: ["a1"] },
    },
  });
  assert.equal(findSlice(meta, "m", "a2", ["a1"]), "weird_name_1");
  assert.equal(findSlice(meta, "m", "a2", []), "weird_name_1", "filters are optional: asking for none is always possible");
  assert.equal(findSlice(meta, "m", "a2", ["a3"]), undefined, "a filter the tool does not offer");
  assert.equal(findSeries(meta, "m", "day", ["d1"]), "weird_name_2?aggregation=day");
  assert.equal(findSeries(meta, "m", "year"), undefined);
  assert.equal(findEvidence(meta, "incidents"), "weird_name_3");
});

test("tools.meta.yaml rejects an unknown kind", () => {
  assert.throws(() => ToolsMeta.parse({ tools: { x: { kind: "magic" } } }));
});
