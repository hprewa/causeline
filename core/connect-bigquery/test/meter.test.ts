import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStop, type Row, type ToolCaller } from "@causeline/runner";
import { explainBigQueryError } from "../src/explain.js";
import { MeteredToolCaller, readStatements, sourceProblem, USD_PER_TIB } from "../src/meter.js";

const toolsYaml = `
kind: tool
name: m_series
type: bigquery-sql
source: bq
parameters:
  - { name: start, type: string, description: s }
  - { name: aggregation, type: string, description: a }
  - { name: site, type: string, description: f, required: false, default: "" }
statement: |
  SELECT 1 WHERE @start > '' AND @aggregation > '' AND @site = '';
---
kind: tool
name: m_by_site
type: bigquery-sql
source: bq
parameters: []
statement: SELECT 2;
---
kind: toolset
name: causeline
tools: [m_series, m_by_site]
`;

class Recorder implements ToolCaller {
  seen: string[] = [];
  async call(tool: string): Promise<Row[]> {
    this.seen.push(tool);
    return [];
  }
}

function meter(budgetBytes: number | null, bytesFor: (sql: string) => number = () => 1_000_000) {
  const dryRuns: { sql: string; params: Record<string, string> }[] = [];
  const inner = new Recorder();
  const m = new MeteredToolCaller(inner, readStatements(toolsYaml), async (sql, params) => {
    dryRuns.push({ sql, params });
    return bytesFor(sql);
  }, budgetBytes);
  return { m, inner, dryRuns };
}

test("statements and parameter defaults are read from the generated Toolbox file", () => {
  const s = readStatements(toolsYaml);
  assert.deepEqual([...s.keys()], ["m_series", "m_by_site"]);
  assert.deepEqual(s.get("m_series")!.params, { start: "", aggregation: "", site: "" });
});

test("each tool is dry-run once; later calls add the same bytes without asking again", async () => {
  const { m, dryRuns } = meter(null);
  await m.call("m_series?aggregation=day", { start: "2026-01-01 00:00:00" }, "s");
  await m.call("m_series?aggregation=week", { start: "2026-01-01 00:00:00" }, "s");
  await m.call("m_by_site", {}, "s");
  assert.equal(dryRuns.length, 2, "two distinct tools, two dry runs");
  assert.deepEqual(m.cost(), { queries: 3, bytes_scanned: 3_000_000, estimated_usd: Math.round((3e6 / 2 ** 40) * USD_PER_TIB * 1e6) / 1e6, budget_bytes: null });
});

test("the dry run is given every declared parameter: the caller's, the bound value, and the defaults", async () => {
  const { m, dryRuns } = meter(null);
  await m.call("m_series?aggregation=day", { start: "2026-01-01 00:00:00" }, "s");
  assert.deepEqual(dryRuns[0].params, { start: "2026-01-01 00:00:00", aggregation: "day", site: "" });
});

test("a query that would pass the budget is not sent, and the run is stopped in plain words", async () => {
  const { m, inner } = meter(2_500_000);
  await m.call("m_by_site", {}, "s");
  await m.call("m_by_site", {}, "s");
  await assert.rejects(m.call("m_by_site", {}, "s"), (e: unknown) => e instanceof RunStop && e.reason === "cost_budget" && /limit for one question/.test(e.detail) && /Narrow it down/.test(e.detail));
  assert.equal(inner.seen.length, 2, "the third query never reached the database");
  assert.equal(m.cost().bytes_scanned, 2_000_000);
});

test("a tool the meter does not know (a test double, a non-generated tool) passes through uncounted by bytes", async () => {
  const { m, inner } = meter(1);
  await m.call("something_else", {}, "s");
  assert.equal(inner.seen.length, 1);
  assert.equal(m.cost().bytes_scanned, 0);
});

test("Google errors become sentences a person can act on", () => {
  assert.match(explainBigQueryError(new Error("invalid_grant: Bad Request")), /sign-in has expired/);
  assert.match(explainBigQueryError(new Error("Could not load the default credentials.")), /No Google sign-in/);
  assert.match(explainBigQueryError(new Error("Not found: Dataset p:d")), /dataset does not exist/);
  assert.match(explainBigQueryError(new Error("Access Denied: Project p: User does not have bigquery.jobs.create permission")), /not allowed to read/);
  assert.match(explainBigQueryError(new Error("something odd")), /BigQuery reported a problem\. \(something odd\)/);
});

test("a BigQuery source without a row limit is refused, because Toolbox would silently return only 50 rows", () => {
  const source = (extra: string) => `kind: source
name: bq
type: bigquery
project: p
${extra}`;
  assert.match(sourceProblem(source(""))!, /only 50 rows/);
  assert.match(sourceProblem(source("maxQueryResultRows: 500"))!, /below 10000/);
  assert.equal(sourceProblem(source("maxQueryResultRows: 100000")), null);
  assert.equal(sourceProblem(["kind: source", "name: s", "type: sqlite", "database: x.db"].join("\n")), null, "other databases are not our concern here");
});
