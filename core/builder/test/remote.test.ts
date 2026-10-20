import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { BudgetError, registerData, type BuilderData, type DataTable } from "../src/data.js";
import { describeData, endNotes } from "../src/profile.js";
import { savePack } from "../src/savepack.js";
import { assertReadOnlySelect } from "../src/sqlguard.js";
import { newState, readState, writeState } from "../src/state.js";
import { testFact } from "../src/testfact.js";

const TABLE = "bigquery-public-data.shop.orders";

/** A BigQuery-shaped database whose answers are written out: each kind of statement the Builder sends is answered from a script. */
function fake(opts: { tables: DataTable[]; answer: (sql: string) => Record<string, unknown>[] | "over"; bytes?: number; queryBytes?: number; types?: Record<string, string> }): BuilderData & { sent: string[] } {
  const sent: string[] = [];
  return {
    dialect: "bigquery",
    sent,
    ref: (t) => `\`${t}\``,
    quote: (c) => `\`${c}\``,
    tables: async () => opts.tables,
    check: async (sql) => ({ ok: true, columns: Object.entries(opts.types ?? {}).map(([name, type]) => ({ name, type })), bytes: opts.bytes ?? 1_000_000 }),
    query: async (sql) => {
      sent.push(sql);
      const out = opts.answer(sql);
      if (out === "over") throw new BudgetError("over the limit", 9e9);
      return { columns: Object.keys(out[0] ?? {}), rows: out, bytes: opts.queryBytes ?? opts.bytes ?? 1_000_000 };
    },
    usage: () => ({ queries: sent.length, bytes: sent.length * (opts.bytes ?? 1_000_000), estimated_usd: 0 }),
    close: () => {},
  };
}

const orders: DataTable = {
  name: TABLE,
  rows: 1_000_000,
  bytes: 3e9,
  kind: "table",
  columns: [
    { name: "ordered_on", type: "DATE" },
    { name: "category", type: "STRING" },
    { name: "subcategory", type: "STRING" },
    { name: "shop", type: "STRING" },
    { name: "delivered_late", type: "BOOLEAN" },
    { name: "amount", type: "FLOAT" },
    { name: "review_text", type: "STRING" },
    { name: "tags", type: "STRING", repeated: true },
  ],
};

function workspace(dialect: "bigquery" | "sqlite" = "bigquery") {
  const ws = mkdtempSync(join(tmpdir(), "remote-"));
  const s = newState("shop-bq");
  if (dialect === "bigquery") {
    s.dialect = "bigquery";
    s.bigquery = { project: "my-project", location: "US" };
    s.tables = [{ name: TABLE, file: TABLE, rows: 1_000_000, columns: 8, notes: [] }];
  }
  writeState(ws, s);
  return ws;
}

const sampleRows = Array.from({ length: 40 }, (_, i) => ({
  ordered_on: "2024-05-01",
  category: i % 2 ? "books" : "toys",
  subcategory: i % 2 ? (i % 4 === 1 ? "novels" : "poetry") : i % 4 === 0 ? "dolls" : "games",
  shop: `shop_${i % 7}`,
  delivered_late: i % 5 === 0,
  amount: i * 1.5,
  review_text: "This is a long sentence a customer wrote about the thing they bought, and it goes on for a good while so that it is clearly not a label at all but free text.",
}));

const stats = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  n: 1_000_000,
  nulls_0: 0, d_0: 2000, lo_0: "2020-01-01", hi_0: "2020-12-31",
  nulls_1: 0, d_1: 2, lo_1: "books", hi_1: "toys",
  nulls_2: 5000, d_2: 4, lo_2: "dolls", hi_2: "poetry",
  nulls_3: 0, d_3: 7, lo_3: "shop_0", hi_3: "shop_6",
  nulls_4: 0, d_4: 2,
  nulls_5: 0, d_5: 900_000, lo_5: "0.5", hi_5: "900.0",
  ...extra,
});

const answer = (aggregate: Record<string, unknown> | "over" | "over-then") => {
  let calls = 0;
  return (sql: string): Record<string, unknown>[] | "over" => {
    if (sql.includes("LIMIT 500")) return sampleRows;
    if (sql.startsWith("SELECT COUNT(*) AS n")) {
      calls++;
      if (aggregate === "over" || (aggregate === "over-then" && calls === 1)) return "over";
      return [aggregate === "over-then" ? stats({ n: 30_000 }) : (aggregate as Record<string, unknown>)];
    }
    if (sql.includes("COUNT(DISTINCT CONCAT")) return [{ c_0: 2, c_1: 4, c_2: 7, p_0: 4, p_1: 9, p_2: 11 }];
    return [];
  };
};

test("a table is profiled in a few passes, free-text and unreadable columns are left out and said so", async () => {
  const ws = workspace();
  const data = fake({ tables: [orders], answer: answer(stats()), bytes: 40e6 });
  registerData("bigquery", async () => data);
  const d = await describeData(ws);
  const aggregate = data.sent.find((s) => s.startsWith("SELECT COUNT(*) AS n"))!;
  assert.ok(!aggregate.includes("review_text"), "the free-text column is never read by the aggregate pass");
  assert.ok(!aggregate.includes("tags"), "a list column is left out");
  assert.ok(aggregate.includes("APPROX_COUNT_DISTINCT(`category`)"));
  assert.ok(data.sent.find((s) => s.includes("LIMIT 500"))!.includes("TABLESAMPLE SYSTEM"), "a 3 GB table is sampled, not read, for example values");
  assert.ok(!data.sent.find((s) => s.includes("LIMIT 500"))!.includes("tags"));
  assert.match(d.notes!.join("\n"), /left out review_text, which holds free text/);
  assert.match(d.notes!.join("\n"), /left out tags \(a list\)/);
  const cols = Object.fromEntries(d.tables[0].columns.map((c) => [c.name, c]));
  assert.deepEqual(cols.ordered_on.roles, ["time"]);
  assert.equal(cols.ordered_on.type, "date");
  assert.deepEqual(cols.delivered_late.roles, ["flag"]);
  assert.ok(cols.category.roles.includes("concept"));
  assert.ok(cols.amount.roles.includes("measure"));
  assert.equal(cols.subcategory.nulls, 5000);
  assert.ok(cols.category.samples.length > 0);
  assert.equal(d.time[0].from, "2020-01-01");
  assert.deepEqual(d.hierarchies, [{ table: TABLE, levels: ["category", "subcategory"] }], "subcategory sits under exactly one category");
  assert.match(d.notes!.join("\n"), /ends on 2020-12-31, well before today.*as_of: data_end/s, "a data set that stopped long ago is pointed at as_of");
  assert.match(d.notes!.join("\n"), /DATE column is not enough on BigQuery.*TIMESTAMP\(column\)/s);
  assert.equal(d.cost!.queries, data.sent.length);
  assert.equal(readState(ws)!.profiled, true);
});

test("a pass that would pass the budget is run on a sample instead, and the counts are marked as estimates", async () => {
  const ws = workspace();
  const data = fake({ tables: [orders], answer: answer("over-then"), bytes: 2e9 });
  registerData("bigquery", async () => data);
  const d = await describeData(ws);
  const agg = data.sent.filter((s) => s.startsWith("SELECT COUNT(*) AS n"));
  assert.equal(agg.length, 2);
  assert.ok(!agg[0].includes("TABLESAMPLE") && agg[1].includes("TABLESAMPLE SYSTEM"));
  assert.match(d.notes!.join("\n"), /would pass the limit for one question.*come from a sample.*estimates/s);
  assert.match(d.notes!.join("\n"), /hierarchies were not looked for, because the table was only sampled/);
  assert.equal(d.hierarchies.length, 0);
  assert.equal(d.tables[0].rows, 1_000_000, "the real row count, scaled up from the sample");
  assert.equal(d.tables[0].columns.find((c) => c.name === "subcategory")!.nulls, Math.round(5000 * (1_000_000 / 30_000)), "counts scaled to the whole table");
});

test("a fixed end date is pointed out only when the data stopped long ago", () => {
  const t = (to: string) => [{ table: "x", column: "ts", from: "2020-01-01", to, days: 10 }];
  assert.equal(endNotes(t("2026-03-10"), new Date("2026-03-20")).length, 0);
  assert.match(endNotes(t("2023-03-23"), new Date("2026-03-20"))[0], /ends on 2023-03-23.*as_of: data_end/s);
});

test("the guard for BigQuery refuses writes and reaches through backticked names", () => {
  for (const bad of ["DELETE FROM `p.d.t` WHERE true", "SELECT 1; DROP TABLE x", "MERGE `p.d.t` USING y ON true WHEN MATCHED THEN DELETE", "EXPORT DATA OPTIONS(uri='gs://x') AS SELECT 1", "CREATE TABLE x AS SELECT 1", "CALL proc()", "WITH a AS (SELECT 1) UPDATE x SET y = 1"]) {
    assert.throws(() => assertReadOnlySelect(bad, "bigquery"), /SELECT|allowed|only/i, bad);
  }
  assert.equal(assertReadOnlySelect("SELECT a FROM `bigquery-public-data.x.update_log` WHERE b = 'drop'", "bigquery"), "SELECT a FROM `bigquery-public-data.x.update_log` WHERE b = 'drop'", "a table called update_log, and a word in a string, are not verbs");
  assert.equal(assertReadOnlySelect("WITH a AS (SELECT 1 AS x) SELECT x FROM a", "bigquery").startsWith("WITH"), true);
});

test("on BigQuery the time column must be a TIMESTAMP and a DATE says exactly what to write", async () => {
  const ws = workspace();
  const rows = [{ ts: "2024-05-01", category: "toys", __causeline_rows: 120 }];
  const asDate = fake({ tables: [orders], answer: () => rows, types: { ts: "DATE", category: "STRING" } });
  const t = await testFact({ workspace: ws, sql: "SELECT ordered_on AS ts, category FROM `p.d.t`", time: "ts", concepts: ["category"], data: asDate });
  assert.equal(t.ok, true);
  assert.equal(t.rows, 120);
  assert.deepEqual(t.sample, [{ ts: "2024-05-01", category: "toys" }], "the row count column is not part of the sample");
  assert.match(t.warnings[0], /the time column ts is a DATE; on BigQuery it must be a TIMESTAMP: write TIMESTAMP\(ts\) in the SELECT/);
  const asTimestamp = fake({ tables: [orders], answer: () => rows, types: { ts: "TIMESTAMP", category: "STRING" } });
  assert.deepEqual((await testFact({ workspace: ws, sql: "SELECT TIMESTAMP(ordered_on) AS ts, category FROM `p.d.t`", time: "ts", data: asTimestamp })).warnings, []);
  const refused = await testFact({ workspace: ws, sql: "DELETE FROM `p.d.t` WHERE true", data: asTimestamp });
  assert.equal(refused.ok, false);
  assert.match(refused.error!, /may only read|must be a SELECT/);
});

const ontology = { time: { levels: ["week", "day"], seasonality: "none" }, hierarchies: { catalogue: ["category", "subcategory"] }, dimensions: ["shop"], metrics: { late_rate: { type: "ratio", direction: "lower_is_better", min_volume: 10 } } };
const draftData = (time: string) => ({
  source: "something-the-agent-guessed",
  facts: { orders: { sql: `SELECT ${time} AS ts, category, subcategory, shop, CAST(delivered_late AS INT64) AS late FROM \`${TABLE}\``, time: "ts", concepts: ["category", "subcategory", "shop"] } },
  metrics: { late_rate: { fact: "orders", numerator: "late" } },
});

test("saving a pack on BigQuery: a DATE time column is refused, the source and dialect are not the agent's to write, and the budget is set from what one pass reads", async () => {
  const ws = workspace();
  const types = { ts: "DATE", category: "STRING", subcategory: "STRING", shop: "STRING", late: "INTEGER" };
  const script = (sql: string) => (sql.includes("COUNT(*) OVER ()") ? [{ ts: "2024-05-01", category: "toys", subcategory: "dolls", shop: "s1", late: 1, __causeline_rows: 100 }] : [{ v0: 40, v1: 100 }]);
  registerData("bigquery", async () => fake({ tables: [orders], answer: script, bytes: 600e6, types }));
  const bad = await savePack({ workspace: ws, ontology, data: draftData("ordered_on") });
  assert.equal(bad.saved, false);
  assert.match(bad.errors.join("\n"), /the time column ts is a DATE/);

  registerData("bigquery", async () => fake({ tables: [orders], answer: script, bytes: 600e6, types: { ...types, ts: "TIMESTAMP" } }));
  const good = await savePack({ workspace: ws, ontology, data: draftData("TIMESTAMP(ordered_on)") });
  assert.equal(good.saved, true, good.errors.join("; "));
  const written = parse(readFileSync(join(ws, "data.yaml"), "utf-8"));
  assert.equal(written.dialect, "bigquery");
  assert.equal(written.source, "shop-bq", "the source is the one the connection wrote, not the agent's guess");
  assert.equal(written.budget_gb, 24, "40 passes of 0.6 GB");
  assert.equal(good.budget_gb, 24);
  assert.match(good.warnings.join("\n"), /a deep dive on this data reads about 12 GB \(about \$.*\); the limit for one question is set to 24 GB/);
  assert.ok(good.cost!.queries >= 2, "what saving read is reported");
  assert.ok((good.tools ?? 0) > 0);
  // a repeated statement answered from BigQuery's cache reads nothing, but the budget is still worked out from what a pass would read
  registerData("bigquery", async () => fake({ tables: [orders], answer: script, bytes: 600e6, queryBytes: 0, types: { ...types, ts: "TIMESTAMP" } }));
  const cached = await savePack({ workspace: ws, ontology, data: draftData("TIMESTAMP(ordered_on)") });
  assert.equal(cached.budget_gb, 24);
  // an explicit budget in the draft is kept
  registerData("bigquery", async () => fake({ tables: [orders], answer: script, bytes: 600e6, types: { ...types, ts: "TIMESTAMP" } }));
  const kept = await savePack({ workspace: ws, ontology, data: { ...draftData("TIMESTAMP(ordered_on)"), budget_gb: 40 } });
  assert.equal(parse(readFileSync(join(ws, "data.yaml"), "utf-8")).budget_gb, 40);
  assert.equal(kept.budget_gb, 40);
});
