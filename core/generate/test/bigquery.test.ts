import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { DataDefs, Ontology } from "@causeline/schema";
import { bigquery } from "../src/bigquery.js";
import { generateTools, renderYaml } from "../src/generate.js";
import { checkGenerated, generateForPack } from "../src/pack.js";

// Neutral vocabulary on purpose: the generator is domain-free.
const ontology = Ontology.parse({
  time: { levels: ["week", "day", "slot"], seasonality: { cycles: ["weekday", "half_hour_of_day"], calendar: ["flag"] } },
  hierarchies: { h1: ["a1", "a2"] },
  dimensions: ["d1"],
  metrics: { m: { type: "ratio", direction: "higher_is_better", min_volume: 10 }, total: { type: "sum", direction: "lower_is_better", min_volume: 10 } },
});

const dataText = `
source: bq
dialect: bigquery
facts:
  events:
    sql: SELECT ts, a1, a2, d1, ok_flag, amount, flag FROM \`proj.ds.events\`
    time: ts
    concepts: [a1, a2, d1]
    time_levels: { slot: "CONCAT(FORMAT_TIMESTAMP('%Y-%m-%d', ts), '-x')" }
    slots: { flag: flag }
metrics:
  m: { fact: events, numerator: ok_flag }
  total: { fact: events, value: amount }
evidence:
  incidents: { sql: "SELECT a1, ts, kind FROM \`proj.ds.incidents\`", time: ts, about: [a1] }
`;
const data = DataDefs.parse(parseAllDocuments(dataText)[0].toJS());

const { tools } = generateTools(ontology, data);
const byName = new Map(tools.map((t) => [t.name, t]));

test("a data definition that names the bigquery dialect is generated in it, with no extra argument", () => {
  assert.equal(data.dialect, "bigquery");
  const docs = parseAllDocuments(renderYaml(tools, "bq", bigquery)).map((d) => d.toJS()).filter((d) => d.kind === "tool");
  assert.ok(docs.length > 10);
  assert.ok(docs.every((d) => d.type === "bigquery-sql"));
  assert.equal(DataDefs.parse({ source: "s", facts: { f: { sql: "SELECT 1", time: "ts" } } }).dialect, "sqlite", "sqlite stays the default");
});

test("parameters are named, every one a statement uses is declared, and no positional placeholder is left", () => {
  for (const t of tools) {
    assert.ok(!t.statement.includes("?"), `${t.name}: no positional placeholder`);
    const used = new Set([...t.statement.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
    const declared = new Set(t.params.map((p) => p.name));
    assert.deepEqual([...used].filter((u) => !declared.has(u)), [], `${t.name}: used but not declared`);
    assert.deepEqual([...declared].filter((d) => !used.has(d)), [], `${t.name}: declared but never used`);
  }
});

test("timestamps are converted from text, bucketed with FORMAT_TIMESTAMP, and returned as text", () => {
  const slice = byName.get("m_by_a2")!.statement;
  assert.match(slice, /TIMESTAMP\(@cur_start\) AS cur_s/);
  assert.match(slice, /`ts` BETWEEN p\.cur_s AND p\.cur_e/);
  const series = byName.get("m_series")!.statement;
  assert.match(series, /CASE p\.aggregation WHEN 'week' THEN FORMAT_TIMESTAMP\('%Y-W%W', `ts`\) WHEN 'day' THEN FORMAT_TIMESTAMP\('%Y-%m-%d', `ts`\) WHEN 'slot' THEN CONCAT\(/);
  assert.match(series, /FORMAT_TIMESTAMP\('%Y-%m-%d %H:%M:%E\*S', MIN\(`ts`\)\) AS bucket_start/);
  assert.match(byName.get("m_extent")!.statement, /FORMAT_TIMESTAMP\('%Y-%m-%d %H:%M:%E\*S', MAX\(`ts`\)\) AS max_ts/);
});

test("slots: a cycle restricts the baseline with STRPOS over the comma list, in BigQuery's own functions", () => {
  const sql = byName.get("m_by_a2")!.statement;
  assert.match(sql, /STRPOS\(CONCAT\(',', p\.s_weekday, ','\), CONCAT\(',', CAST\(FORMAT_TIMESTAMP\('%w', `ts`\) AS STRING\), ','\)\) > 0/);
  assert.match(sql, /IF\(EXTRACT\(MINUTE FROM `ts`\) < 30, '00', '30'\)/);
  assert.ok(!/strftime|instr\(|CAST\([^)]* AS TEXT\)/.test(sql), "no SQLite functions");
});

test("onboarding and evidence tools are in BigQuery too", () => {
  assert.match(byName.get("events_check_nulls")!.statement, /COUNTIF\(`ts` IS NULL\) AS `ts`/);
  assert.match(byName.get("events_check_parent_a2")!.statement, /STRING_AGG\(c, ', '\)/);
  assert.match(byName.get("m_seasonal_weekday")!.statement, /BETWEEN TIMESTAMP\(@start\) AND TIMESTAMP\(@end\)/);
  assert.match(byName.get("m_seasonal_weekday")!.statement, /CAST\(FORMAT_TIMESTAMP\('%w', `ts`\) AS STRING\) AS slot/);
  const ev = byName.get("incidents")!.statement;
  assert.match(ev, /TIMESTAMP\(@start\) AS w_start, TIMESTAMP\(@end\) AS w_end, @a1 AS `a1`/);
});

test("a pack target reads data.<target>.yaml and writes its own generated files, leaving the standard ones alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "target-"));
  writeFileSync(join(dir, "ontology.yaml"), "time:\n  levels: [week, day]\n  seasonality: none\nhierarchies:\n  h: [a1]\ndimensions: []\nmetrics:\n  m: { type: ratio, direction: higher_is_better, min_volume: 10 }\n");
  const dataFor = (dialect: string, sql: string) => `source: s\ndialect: ${dialect}\nfacts:\n  f: { sql: "${sql}", time: ts, concepts: [a1] }\nmetrics:\n  m: { fact: f, numerator: ok }\n`;
  writeFileSync(join(dir, "data.yaml"), dataFor("sqlite", "SELECT * FROM t"));
  writeFileSync(join(dir, "data.bigquery.yaml"), dataFor("bigquery", "SELECT * FROM `p.d.t`"));
  mkdirSync(join(dir, "toolbox"));
  assert.equal(checkGenerated(dir, "bigquery"), "missing");
  const a = generateForPack(dir);
  const b = generateForPack(dir, { target: "bigquery" });
  assert.match(a.path, /toolbox[\\/]tools\.generated\.yaml$/);
  assert.match(b.path, /toolbox\.bigquery[\\/]tools\.generated\.yaml$/);
  assert.match(b.metaPath, /tools\.meta\.bigquery\.yaml$/);
  assert.match(readFileSync(a.path, "utf-8"), /type: sqlite-sql/);
  assert.match(readFileSync(b.path, "utf-8"), /type: bigquery-sql/);
  assert.equal(checkGenerated(dir), "fresh");
  assert.equal(checkGenerated(dir, "bigquery"), "fresh");
  writeFileSync(join(dir, "data.bigquery.yaml"), dataFor("bigquery", "SELECT 1 AS ts, 1 AS a1, 1 AS ok FROM `p.d.t`"));
  assert.equal(checkGenerated(dir, "bigquery"), "stale");
  assert.equal(checkGenerated(dir), "fresh", "the other target is unaffected");
});
