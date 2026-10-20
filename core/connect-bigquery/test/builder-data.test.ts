import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { BudgetError, readState, writeState, newState, type DataTable } from "@causeline/builder";
import { BigQueryData, bigQueryProject, connectBigQuery, parseTableRef, plain, type BigQueryApi, type TableRef } from "../src/index.js";
import { sourceProblem } from "../src/meter.js";

const orders: DataTable = { name: "pub.shop.orders", rows: 1000, bytes: 2e9, kind: "table", columns: [{ name: "ts", type: "TIMESTAMP" }, { name: "tags", type: "STRING", repeated: true }] };

function api(over: Partial<BigQueryApi> & { type?: string; bytes?: number } = {}): BigQueryApi & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    dryRun: over.dryRun ?? (async () => ({ statementType: over.type ?? "SELECT", columns: [{ name: "n", type: "INTEGER" }], bytes: over.bytes ?? 1e9 })),
    run: over.run ?? (async (sql) => (ran.push(sql), { rows: [{ n: 1 }], bytes: over.bytes ?? 1e9 })),
    table: over.table ?? (async (r: TableRef) => ({ ...orders, name: `${r.project}.${r.dataset}.${r.table}` })),
    tables: over.tables ?? (async (r) => [{ ...r, table: "orders" }, { ...r, table: "customers" }]),
  };
}
const refs = [{ project: "pub", dataset: "shop", table: "orders" }];

test("a statement BigQuery does not call a SELECT is refused before it is run", async () => {
  const a = api({ type: "DELETE" });
  const d = new BigQueryData(a, { tables: refs, budgetBytes: 5e9 });
  assert.deepEqual((await d.check("DELETE FROM x WHERE true")).ok, false);
  assert.match((await d.check("DELETE FROM x WHERE true")).error!, /reads this as a DELETE; only reading is allowed/);
  await assert.rejects(d.query("DELETE FROM x WHERE true"), /only reading is allowed/);
  assert.equal(a.ran.length, 0, "nothing was sent");
});

test("every step is priced first, refused before it would pass the budget, and what was read is reported", async () => {
  const a = api({ bytes: 2e9 });
  const d = new BigQueryData(a, { tables: refs, budgetBytes: 5e9 });
  assert.equal((await d.query("SELECT 1")).bytes, 2e9);
  assert.equal((await d.query("SELECT 2")).bytes, 2e9);
  await assert.rejects(d.query("SELECT 3"), (e: Error) => e instanceof BudgetError && /would read 2\.0 GB .*4\.0 GB already read.*limit of 5\.0 GB/.test(e.message));
  assert.equal(a.ran.length, 2, "the third was never sent");
  assert.deepEqual(d.usage(), { queries: 2, bytes: 4e9, estimated_usd: Math.round((4e9 / 2 ** 40) * 6.25 * 1e6) / 1e6 });
  const free = new BigQueryData(api({ bytes: 9e12 }), { tables: refs, budgetBytes: null });
  assert.equal((await free.query("SELECT 1")).rows.length, 1, "no limit when the limit is 0");
});

test("values come back as plain data, and names are quoted safely", () => {
  assert.equal(plain({ value: "2024-05-01T00:00:00.000Z" }), "2024-05-01T00:00:00.000Z");
  assert.equal(plain(new Date("2024-05-01T00:00:00Z")), "2024-05-01T00:00:00.000Z");
  assert.deepEqual(plain([1, { value: "x" }, null]), [1, "x", null]);
  const big = new (class Big { toString() { return "12.5"; } })();
  assert.equal(plain(big), 12.5);
  const d = new BigQueryData(api(), { tables: refs, budgetBytes: null });
  assert.equal(d.ref("a.b.c`; DROP"), "`a.b.c; DROP`", "a backtick cannot close the name early");
  assert.equal(d.quote("odd`name"), "`oddname`");
  assert.deepEqual(parseTableRef("shop.orders", "mine"), { project: "mine", dataset: "shop", table: "orders" });
  assert.deepEqual(parseTableRef("`pub.shop.orders`", "mine"), { project: "pub", dataset: "shop", table: "orders" });
  assert.throws(() => parseTableRef("orders", "mine"), /not a table name/);
});

test("connecting reads descriptions only, writes a source Toolbox can use safely, and remembers the project", async () => {
  const ws = join(mkdtempSync(join(tmpdir(), "bq-connect-")), "complaints");
  const r = await connectBigQuery({ workspace: ws, project: "my-project", table: "pub.shop.orders", api: api() });
  assert.equal(r.connected, true, r.summary);
  assert.equal(r.read_bytes, 0);
  assert.match(r.summary, /Connected to 1 BigQuery table \(2\.0 GB in all\); queries are billed to my-project\. Nothing was read yet/);
  assert.deepEqual(r.tables[0].columns.map((c) => c.type), ["TIMESTAMP", "ARRAY<STRING>"]);
  const source = readFileSync(join(ws, "toolbox", "source.yaml"), "utf-8");
  assert.equal(sourceProblem(source), null, "Toolbox would return every row");
  const parsed = parse(source);
  assert.equal(parsed.project, "my-project");
  assert.equal(parsed.type, "bigquery");
  assert.ok(!("writeMode" in parsed), "writeMode: blocked would hide every query tool");
  const state = readState(ws)!;
  assert.equal(state.dialect, "bigquery");
  assert.deepEqual(state.bigquery, { project: "my-project", location: "US" });
  assert.equal(state.source, parsed.name);
  assert.equal(state.tables[0].name, "pub.shop.orders");
  assert.equal(bigQueryProject(ws, {}), "my-project", "found again without the environment variable");
  assert.equal(bigQueryProject(ws, { CAUSELINE_BQ_PROJECT: "other" }), "other", "the environment decides first");
});

test("a dataset connects its tables; asking for both, neither, a missing project or a folder of files is answered in words", async () => {
  const ws = join(mkdtempSync(join(tmpdir(), "bq-connect-")), "shop");
  const r = await connectBigQuery({ workspace: ws, project: "my-project", dataset: "pub.shop", api: api() });
  assert.equal(r.tables.length, 2);
  assert.equal(readState(ws)!.bigquery!.dataset, "pub.shop");
  const base = join(mkdtempSync(join(tmpdir(), "bq-connect-")), "w");
  assert.match((await connectBigQuery({ workspace: base, project: "p", api: api() })).summary, /either a table .* or a dataset/);
  assert.match((await connectBigQuery({ workspace: base, project: "p", table: "a.b.c", dataset: "x", api: api() })).summary, /either a table .* or a dataset/);
  assert.match((await connectBigQuery({ workspace: base, table: "a.b.c", api: api() })).summary.replace(/\s+/g, " "), /Which Google Cloud project/);
  const files = join(mkdtempSync(join(tmpdir(), "bq-connect-")), "mine");
  const s = newState("mine-db");
  s.tables = [{ name: "calls", file: "calls.csv", rows: 5, columns: 2, notes: [] }];
  writeState(files, s);
  assert.match((await connectBigQuery({ workspace: files, project: "p", table: "a.b.c", api: api() })).summary, /already holds the user's own files/);
  const missing = await connectBigQuery({ workspace: base, project: "p", table: "a.b.nope", api: api({ table: async () => { throw Object.assign(new Error("Not found: Table a:b.nope"), { code: 404 }); } }) });
  assert.equal(missing.connected, false);
  assert.match(missing.summary, /a\.b\.nope/);
  assert.equal(readState(base), null, "nothing is written when the connection fails");
});

test("a view is flagged, and a large dataset is cut to the first tables with a note", async () => {
  const base = join(mkdtempSync(join(tmpdir(), "bq-connect-")), "v");
  const r = await connectBigQuery({ workspace: base, project: "p", table: "a.b.v", api: api({ table: async () => ({ name: "a.b.v", columns: [{ name: "x", type: "STRING" }], kind: "view" }) }) });
  assert.match(r.notes.join("\n"), /is a view: it cannot be sampled/);
  const many = join(mkdtempSync(join(tmpdir(), "bq-connect-")), "m");
  const big = await connectBigQuery({ workspace: many, project: "p", dataset: "a.b", api: api({ tables: async (r) => Array.from({ length: 25 }, (_, i) => ({ ...r, table: `t${i}` })) }) });
  assert.equal(big.tables.length, 20);
  assert.match(big.notes.join("\n"), /25 tables; the first 20 are connected/);
});

test("the limit for one question: the environment first, then the pack's own figure, then the default", async () => {
  const { withCostControl } = await import("../src/meter.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "bq-budget-"));
  mkdirSync(join(dir, "toolbox"));
  const write = (budget: string) => {
    writeFileSync(join(dir, "ontology.yaml"), "time: { levels: [week, day], seasonality: none }\nhierarchies: {}\ndimensions: [d]\nmetrics:\n  m: { type: sum, direction: higher_is_better, min_volume: 1 }\n");
    writeFileSync(join(dir, "data.yaml"), `source: bq\ndialect: bigquery\n${budget}facts:\n  f:\n    sql: SELECT 1\n    time: ts\n    concepts: [d]\nmetrics:\n  m: { fact: f, value: "1" }\n`);
  };
  writeFileSync(join(dir, "toolbox", "source.yaml"), "kind: source\nname: bq\ntype: bigquery\nproject: p\nlocation: US\nmaxQueryResultRows: 100000\n");
  writeFileSync(join(dir, "toolbox", "tools.generated.yaml"), "kind: tool\nname: t\ntype: bigquery-sql\nsource: bq\nparameters: []\nstatement: SELECT 1;\n");
  const inner = { call: async () => [] };
  const budget = (env: Record<string, string>) => (withCostControl(dir, inner, { CAUSELINE_BQ_PROJECT: "p", ...env }) as unknown as { cost(): { budget_bytes: number | null } }).cost().budget_bytes;
  write("budget_gb: 15\n");
  assert.equal(budget({}), 15e9, "the pack's own figure");
  assert.equal(budget({ CAUSELINE_BQ_BUDGET_GB: "2" }), 2e9, "the environment decides first");
  assert.equal(budget({ CAUSELINE_BQ_BUDGET_GB: "0" }), null, "0 is no limit");
  write("");
  assert.equal(budget({}), 5e9, "the default");
});
