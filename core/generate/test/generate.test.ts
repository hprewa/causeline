import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";
import { DataDefs, findEvidence, findSeries, findSlice, Ontology, ToolsMeta } from "@causeline/schema";
import { generateTools, renderMeta, renderYaml } from "../src/generate.js";

// Neutral vocabulary on purpose: the generator is domain-free.
const FACT_SQL = `SELECT e.ts, e.a1, p.a2, p.a3, e.b1, e.b2, e.d1, e.ok_flag, e.amount, e.flag
FROM events e JOIN parts p USING (part_id)`;

const ontologyOf = (seasonality: unknown = "none", over: Record<string, unknown> = {}) =>
  Ontology.parse({
    time: { levels: ["week", "day", "slot"], seasonality },
    hierarchies: { h1: ["a1", "a2", "a3"], h2: ["b1", "b2"] },
    dimensions: ["d1"],
    metrics: {
      m: { type: "ratio", direction: "higher_is_better", min_volume: 10 },
      total: { type: "sum", direction: "lower_is_better", min_volume: 10 },
      work: { type: "product", drivers: ["total", "m"], direction: "lower_is_better" },
    },
    ...over,
  });

const dataOf = (slots: Record<string, unknown> = {}) =>
  DataDefs.parse({
    source: "src",
    facts: {
      events: {
        sql: FACT_SQL,
        time: "ts",
        concepts: ["a1", "a2", "a3", "b1", "b2", "d1"],
        time_levels: { slot: "strftime('%Y-%m-%d', ts) || '-x'" },
        slots,
      },
    },
    metrics: { m: { fact: "events", numerator: "ok_flag" }, total: { fact: "events", value: "amount" } },
    evidence: { incidents: { description: "Incident log.", sql: "SELECT a1, b1, ts, kind FROM incidents", time: "ts", about: ["a1", "b1"] } },
  });

const { tools, skipped, meta } = generateTools(ontologyOf(), dataOf());
const byName = new Map(tools.map((t) => [t.name, t]));

test("emits each tool family for a ratio metric", () => {
  for (const name of [
    "m_extent",
    "m_by_week", "m_by_day", "m_by_slot",
    "m_by_a1", "m_by_a2_in_a1", "m_by_a3_in_a2", "m_by_a2", "m_by_a3",
    "m_by_b1", "m_by_b2_in_b1",
    "m_by_d1", "m_by_d1_in_a1", "m_by_d1_in_b2",
    "m_by_day_for_a1", "m_by_day_for_b2", "m_by_day_for_d1",
  ]) {
    assert.ok(byName.has(name), `missing tool ${name}`);
  }
  assert.ok(!byName.has("row_counts") && !byName.has("coverage_by_a1"), "coverage comes from the slice denominators; there is one extent tool per metric");
});

test("every statement reads from the fact's own SELECT, so joins live in data.yaml only", () => {
  const s = byName.get("m_by_a2_in_a1")!.statement;
  assert.match(s, /FROM \(SELECT e\.ts, e\.a1, p\.a2/);
  assert.match(s, /JOIN parts p USING \(part_id\)\) AS "events", p/);
  assert.ok(!/FROM "facts"/.test(s));
});

test("a sum metric gets the same tool family, with a sum of squares for its variance", () => {
  assert.deepEqual(skipped, [], "nothing is skipped");
  for (const name of ["total_by_week", "total_by_a2_in_a1", "total_by_a2", "total_by_d1", "total_by_d1_in_a1", "total_by_day_for_a1"]) {
    assert.ok(byName.has(name), `missing tool ${name}`);
  }
  const children = byName.get("total_by_a2_in_a1")!.statement;
  assert.match(children, /SUM\(CASE WHEN "ts" BETWEEN p.cur_s AND p.cur_e THEN \(amount\) END\), 0\) AS cur_num/);
  assert.match(children, /THEN 1 END\), 0\) AS cur_den/, "the row count");
  assert.match(children, /THEN \(amount\) \* \(amount\) END\), 0\) AS cur_sq/);
  assert.match(children, /AS base_sq\s*\nFROM/, "no trailing comma after the last column");
  assert.match(byName.get("total_by_week")!.statement, /AS num, COALESCE\(SUM\(1\), 0\) AS den, COALESCE\(SUM\(\(amount\) \* \(amount\)\), 0\) AS sq/);
});

test("ratio tools also carry the sum of squared numerators, for non-binary numerators", () => {
  const children = byName.get("m_by_a2_in_a1")!.statement;
  assert.match(children, /THEN \(ok_flag\) \* \(ok_flag\) END\), 0\) AS cur_sq/);
  assert.match(children, /AS base_sq\s*\nFROM/);
  assert.match(byName.get("m_by_week")!.statement, /COALESCE\(SUM\(\(ok_flag\) \* \(ok_flag\)\), 0\) AS sq/);
});

test("a product metric generates no tools of its own; its drivers do", () => {
  assert.ok(![...byName.keys()].some((n) => n.startsWith("work_")));
  assert.ok(byName.has("total_by_week") && byName.has("m_by_week"));
});

test("every statement has exactly one placeholder per declared parameter", () => {
  for (const t of tools) {
    const placeholders = (t.statement.match(/\?/g) ?? []).length;
    assert.equal(placeholders, t.params.length, `${t.name}: ${placeholders} placeholders vs ${t.params.length} params`);
  }
});

test("parameter order follows placeholder order for parent-scoped tools", () => {
  const t = byName.get("m_by_a2_in_a1")!;
  assert.deepEqual(t.params.map((p) => p.name), ["cur_start", "cur_end", "base_start", "base_end", "a1"]);
  assert.match(t.statement, /"a1" = \?\s*\nGROUP BY "a2"/);
});

test("a custom time level uses the data definition's SQL; a built-in uses the dialect's", () => {
  assert.match(byName.get("m_by_slot")!.statement, /strftime\('%Y-%m-%d', ts\) \|\| '-x'/);
  assert.match(byName.get("m_by_week")!.statement, /strftime\('%Y-W%W', "ts"\)/);
});

test("persistence tools use the second time level", () => {
  assert.ok(byName.get("m_by_day_for_a2")!.statement.includes('"a2" = ?'));
  assert.ok(!byName.has("m_by_week_for_a2"));
});

test("rendered YAML is multi-document, Toolbox-shaped, with no extra fields, and every parameter has a description", () => {
  const docs = parseAllDocuments(renderYaml(tools, "src")).map((d) => d.toJS());
  const toolDocs = docs.filter((d) => d.kind === "tool");
  assert.equal(toolDocs.length, tools.length);
  for (const d of toolDocs) {
    assert.equal(d.type, "sqlite-sql");
    assert.equal(d.source, "src");
    assert.deepEqual(Object.keys(d).sort(), ["description", "kind", "name", "parameters", "source", "statement", "type"], "Toolbox rejects unknown fields");
    for (const p of d.parameters ?? []) assert.ok(p.name && p.type && p.description);
  }
  const toolset = docs.find((d) => d.kind === "toolset");
  assert.equal(toolset.name, "causeline");
  assert.equal(toolset.tools.length, tools.length);
});

test("duplicate tool names are rejected", () => {
  const clash = Ontology.parse({
    time: { levels: ["day"], seasonality: "none" },
    hierarchies: { h: ["x"] },
    dimensions: ["x"],
    metrics: { m: { type: "ratio", direction: "higher_is_better" } },
  });
  const data = DataDefs.parse({ source: "s", facts: { f: { sql: "SELECT 1", time: "ts", concepts: ["x"] } }, metrics: { m: { fact: "f", numerator: "1" } } });
  assert.throws(() => generateTools(clash, data), /duplicate tool name/);
});

test("global per-level tools carry no parent filter", () => {
  const global = byName.get("m_by_a2")!;
  assert.deepEqual(global.params.map((p) => p.name), ["cur_start", "cur_end", "base_start", "base_end"]);
  assert.ok(!/"a1" = \?/.test(global.statement));
  assert.match(global.statement, /GROUP BY "a2"/);
});

// --- the sidecar index: tools are found by what they answer ---------------------------------------

test("the sidecar index says what every tool answers, and round-trips through its schema", () => {
  assert.deepEqual(meta.tools.m_by_a2_in_a1, { kind: "slice", metric: "m", by: "a2", filters: ["a1"] });
  assert.deepEqual(meta.tools.m_by_a2, { kind: "slice", metric: "m", by: "a2", filters: [] });
  assert.deepEqual(meta.tools.m_by_day_for_a1, { kind: "series", metric: "m", level: "day", filters: ["a1"] });
  assert.equal(findSlice(meta, "total", "d1", ["b2"]), "total_by_d1_in_b2");
  assert.equal(findSeries(meta, "m", "slot"), "m_by_slot");
  assert.equal(Object.keys(meta.tools).length, tools.length);
  assert.deepEqual(ToolsMeta.parse(JSON.parse(JSON.stringify(meta))), meta);
  assert.match(renderMeta(meta), /^# GENERATED/);
});

// --- evidence --------------------------------------------------------------------------------------

test("an evidence source becomes one tool: a window, and an optional filter per concept it is about", () => {
  const t = byName.get("incidents")!;
  assert.deepEqual(t.params.map((p) => [p.name, p.optional ?? false]), [["start", false], ["end", false], ["a1", true], ["b1", true]]);
  assert.match(t.statement, /SELECT e\.\* FROM \(SELECT a1, b1, ts, kind FROM incidents\) AS e, p/);
  assert.match(t.statement, /\(p\."a1" = '' OR e\."a1" = p\."a1"\)/);
  assert.match(t.statement, /LIMIT 200/);
  assert.equal(findEvidence(meta, "incidents"), "incidents");
  assert.deepEqual(meta.tools.incidents, { kind: "evidence", evidence: "incidents", about: ["a1", "b1"] });
});

// --- seasonality: slots become columns and baseline-only filters -----------------------------------

const seasonal = generateTools(ontologyOf({ cycles: ["weekday"], calendar: ["flag"] }), dataOf());
const sByName = new Map(seasonal.tools.map((t) => [t.name, t]));

test("seasonal: node tools take one optional slot parameter per cycle and per calendar flag", () => {
  const t = sByName.get("m_by_a2_in_a1")!;
  assert.deepEqual(t.params.map((p) => p.name), ["cur_start", "cur_end", "base_start", "base_end", "s_weekday", "s_flag", "a1"]);
  assert.deepEqual(t.params.filter((p) => p.optional).map((p) => p.name), ["s_weekday", "s_flag"]);
  assert.match(t.statement, /WITH p AS \(SELECT \? AS cur_s, \? AS cur_e, \? AS base_s, \? AS base_e, \? AS s_weekday, \? AS s_flag\)/);
  for (const tool of seasonal.tools) assert.equal((tool.statement.match(/\?/g) ?? []).length, tool.params.length, tool.name);
});

test("seasonal: a cycle slot restricts the BASELINE rows only; a calendar flag restricts both sides", () => {
  const sql = sByName.get("m_by_a2_in_a1")!.statement;
  const lines = sql.split("\n");
  const cur = lines.filter((l) => /AS cur_(num|den|sq)\b/.test(l));
  const base = lines.filter((l) => /AS base_(num|den|sq)\b/.test(l));
  assert.equal(cur.length, 3);
  assert.equal(base.length, 3);
  for (const l of cur) {
    assert.doesNotMatch(l, /p\.s_weekday/, "no cycle filter on current rows");
    assert.match(l, /p\.s_flag = ''/, "a calendar flag filters the current rows too");
  }
  for (const l of base) {
    assert.match(l, /BETWEEN p\.base_s AND p\.base_e AND \(p\.s_weekday = '' OR instr\(',' \|\| p\.s_weekday \|\| ',', ',' \|\| CAST\(strftime\('%w', "ts"\) AS TEXT\) \|\| ','\) > 0\)/);
    assert.match(l, /p\.s_flag = ''/, "calendar flags filter the baseline too");
  }
});

test("seasonal: series tools report each bucket's slot, or NULL when the bucket spans several", () => {
  const sql = sByName.get("m_by_day")!.statement;
  assert.match(sql, /CASE WHEN MIN\(strftime\('%w', "ts"\)\) = MAX\(strftime\('%w', "ts"\)\) THEN MIN\(strftime\('%w', "ts"\)\) END AS slot_weekday/);
  assert.match(sql, /CASE WHEN MIN\("flag"\) = MAX\("flag"\) THEN MIN\("flag"\) END AS slot_flag/);
  assert.ok(sByName.get("m_by_day_for_a1")!.statement.includes("AS slot_weekday"), "persistence series too");
});

test("seasonal: a flag that is SQL in data.yaml uses that SQL", () => {
  const withSql = generateTools(ontologyOf({ cycles: ["weekday"], calendar: ["flag"] }), dataOf({ flag: "CASE WHEN a1 = 'x' THEN 1 ELSE 0 END" }));
  assert.match(withSql.tools.find((t) => t.name === "m_by_day")!.statement, /MIN\(CASE WHEN a1 = 'x' THEN 1 ELSE 0 END\)/);
});

test("seasonal: slot parameters render as optional with an empty default; a flat ontology adds none", () => {
  const doc = parseAllDocuments(renderYaml(seasonal.tools, "src")).map((d) => d.toJS()).find((d) => d.name === "m_by_a2_in_a1");
  const slot = doc.parameters.find((p: { name: string }) => p.name === "s_weekday");
  assert.equal(slot.required, false);
  assert.equal(slot.default, "");
  assert.ok(!byName.get("m_by_a2_in_a1")!.params.some((p) => p.name.startsWith("s_")), "seasonality: none has no slot parameters");
  assert.ok(!byName.get("m_by_day")!.statement.includes("slot_"));
});

test("seasonal: a pack-defined cycle uses its own SQL from data.yaml", () => {
  const custom = generateTools(ontologyOf({ cycles: ["pay"] }), dataOf({ pay: { expr: "CAST(strftime('%d', ts) AS INTEGER) / 7", instance: "date(ts)", cycle_days: 30 } }));
  assert.match(custom.tools.find((t) => t.name === "m_by_day")!.statement, /MIN\(CAST\(strftime\('%d', ts\) AS INTEGER\) \/ 7\)/);
  assert.ok(custom.tools.some((t) => t.name === "m_seasonal_pay"), "a custom cycle is also a candidate for onboarding");
});

test("a cycle that is neither built in nor defined cannot be generated", () => {
  assert.throws(() => generateTools(ontologyOf({ cycles: ["pay"] }), dataOf()), /cycle "pay" is not built in/);
});

// --- onboarding: seasonal-test and data-check tools ------------------------------------------------

test("onboarding: each metric gets a tool per candidate cycle and per calendar flag", () => {
  for (const name of ["m_seasonal_weekday", "m_seasonal_hour_of_day", "m_seasonal_half_hour_of_day", "m_seasonal_day_of_month", "m_seasonal_month_of_year", "total_seasonal_weekday"]) {
    assert.ok(byName.has(name), `missing ${name}`);
  }
  assert.ok(sByName.has("m_seasonal_flag"), "a declared calendar flag is a candidate");
  assert.ok(!byName.has("work_seasonal_weekday"), "products have no tools of their own");
  assert.deepEqual(meta.tools.m_seasonal_weekday, { kind: "seasonal_profile", metric: "m", cycle: "weekday" });
});

test("onboarding: a ratio's components are by slot, with occurrences counted; a total is taken per occurrence first", () => {
  const ratio = byName.get("m_seasonal_weekday")!.statement;
  assert.match(ratio, /CAST\(strftime\('%w', "ts"\) AS TEXT\) AS slot, COUNT\(DISTINCT date\("ts"\)\) AS instances/);
  assert.match(ratio, /COALESCE\(SUM\(\(ok_flag\)\), 0\) AS num, COALESCE\(SUM\(\(1\)\), 0\) AS den, COALESCE\(SUM\(\(ok_flag\) \* \(ok_flag\)\), 0\) AS sq/);
  const total = byName.get("total_seasonal_weekday")!.statement;
  assert.match(total, /FROM \(SELECT CAST\(strftime\('%w', "ts"\) AS TEXT\) AS slot, date\("ts"\) AS inst, SUM\(\(amount\)\) AS t/);
  assert.match(total, /COALESCE\(SUM\(t \* t\), 0\) AS sq/);
  assert.deepEqual(byName.get("m_seasonal_weekday")!.params.map((p) => p.name), ["start", "end"]);
});

test("onboarding: structural checks are per fact and cover parents, levels, days, nulls and values", () => {
  for (const name of ["events_check_parent_a2", "events_check_parent_a3", "events_check_parent_b2", "events_check_level_a1", "events_check_level_b2", "events_check_daily_rows", "events_check_nulls", "check_values_m", "check_values_total"]) {
    assert.ok(byName.has(name), `missing ${name}`);
  }
  assert.ok(!byName.has("events_check_parent_a1"), "a top level has no parent");
  assert.match(byName.get("events_check_parent_a2")!.statement, /GROUP BY "a2" HAVING COUNT\(DISTINCT "a1"\) > 1/);
  assert.match(byName.get("events_check_nulls")!.statement, /SUM\("ts" IS NULL\)/);
  assert.deepEqual(meta.tools.events_check_parent_a2, { kind: "check", check: "parent", fact: "events", arg: "a2" });
});
