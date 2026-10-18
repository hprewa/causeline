import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { conceptsOf, Ontology } from "../src/ontology.js";

// Vocabulary only: no tables, columns or SQL anywhere in an ontology.
const YAML = `
time:
  levels: [week, day, shift, hour]
  seasonality:
    cycles: [weekday]
    calendar: [is_holiday, is_peak]
hierarchies:
  location: [network, region, site, zone]
  product: [category, item_group, item]
dimensions: [channel, customer_segment]
metrics:
  success_rate:
    type: ratio
    direction: higher_is_better
    min_volume: 200
    description: Delivered on time and in full, over all cases.
    synonyms: ["completion", "completion rate"]
    children: [on_time, in_full]
    relation: both_required
  on_time: { type: ratio, direction: higher_is_better, min_volume: 200 }
  in_full: { type: ratio, direction: higher_is_better, min_volume: 200 }
  handling_cost: { type: sum, direction: lower_is_better, min_volume: 200 }
  requests_sent: { type: sum, direction: higher_is_better }
  cost_per_request: { type: ratio, direction: lower_is_better }
  handling_spend: { type: product, drivers: [requests_sent, cost_per_request], direction: lower_is_better }
`;

const load = () => parseYaml(YAML);

test("an ontology is vocabulary: levels are plain names and KPIs carry no formulas", () => {
  const o = Ontology.parse(load());
  assert.deepEqual(o.time.levels, ["week", "day", "shift", "hour"]);
  assert.equal(o.metrics.success_rate.type, "ratio");
  assert.deepEqual(o.metrics.success_rate.children, ["on_time", "in_full"]);
  assert.equal(o.metrics.success_rate.relation, "both_required");
  assert.ok(!("numerator" in o.metrics.success_rate));
});

test("concepts are the hierarchy levels and the flat dimensions", () => {
  assert.deepEqual(conceptsOf(Ontology.parse(load())), ["network", "region", "site", "zone", "category", "item_group", "item", "channel", "customer_segment"]);
});

test("the old table-shaped fields are not part of an ontology any more", () => {
  const withEntity = { ...load(), entity: { table: "requests", id: "request_id" } };
  // unknown keys are stripped, not smuggled in: the parsed ontology has no such field
  assert.ok(!("entity" in Ontology.parse(withEntity)));
  const withFormula = load();
  withFormula.metrics.success_rate.numerator = "on_time * in_full";
  assert.ok(!("numerator" in Ontology.parse(withFormula).metrics.success_rate));
});

test("rejects a hierarchy with duplicate levels, no metrics, and a product that lacks a direction or drivers", () => {
  const dup = load();
  dup.hierarchies.location = ["region", "region", "site"];
  assert.throws(() => Ontology.parse(dup));
  const none = load();
  none.metrics = {};
  assert.throws(() => Ontology.parse(none));
  const noDir = load();
  delete noDir.metrics.handling_spend.direction;
  assert.throws(() => Ontology.parse(noDir));
  const oneDriver = load();
  oneDriver.metrics.handling_spend.drivers = ["requests_sent"];
  assert.throws(() => Ontology.parse(oneDriver));
});

test("a time level must be a plain identifier", () => {
  const bad = load();
  bad.time.levels = ["week", "strftime('%d', ts)"];
  assert.throws(() => Ontology.parse(bad));
});

test("seasonality is mandatory: cycles and calendar flags by name, or an explicit none", () => {
  const without = load();
  delete without.time.seasonality;
  assert.throws(() => Ontology.parse(without), /seasonality/i);
  const none = load();
  none.time.seasonality = "none";
  assert.equal(Ontology.parse(none).time.seasonality, "none");
  const s = Ontology.parse(load()).time.seasonality;
  assert.notEqual(s, "none");
  if (s !== "none") assert.deepEqual([s.cycles, s.calendar], [["weekday"], ["is_holiday", "is_peak"]]);
});

test("an empty seasonality block and duplicate names are rejected", () => {
  const bad = (seasonality: unknown) => {
    const o = load();
    o.time.seasonality = seasonality;
    return () => Ontology.parse(o);
  };
  assert.throws(bad({}), /at least one cycle/);
  assert.throws(bad({ cycles: ["a", "a"] }), /unique/);
  assert.throws(bad({ cycles: ["weekday"], calendar: ["weekday"] }), /unique/);
});
