import { test } from "node:test";
import assert from "node:assert/strict";
import { draftSentences, lateArrival, profileRisks, shortlistTables, wordsOf, type DataDescription, type DataTable } from "../src/index.js";

const t = (name: string, cols: [string, string][], extra: Partial<DataTable> = {}): DataTable => ({ name, columns: cols.map(([n, ty]) => ({ name: n, type: ty })), kind: "table", ...extra });

const tables = [
  t("p.d.complaints", [["complaint_id", "INT64"], ["date_received", "DATE"], ["product", "STRING"], ["company", "STRING"]], { bytes: 9e9 }),
  t("p.d.company_lookup", [["company", "STRING"], ["parent", "STRING"]], { bytes: 1e6 }),
  t("p.d.payments", [["payment_id", "INT64"], ["paid_at", "TIMESTAMP"], ["amount", "FLOAT64"]], { bytes: 4e9 }),
  t("p.d.audit_log", [["event", "STRING"], ["at", "TIMESTAMP"]]),
];

test("words are cut to their meaningful part and plurals meet singulars", () => {
  assert.deepEqual(wordsOf("How many complaints per Company?"), ["complaint", "company"]);
  assert.deepEqual(wordsOf("deliveries"), ["delivery"]);
  assert.deepEqual(wordsOf("customerSatisfaction_score"), ["customer", "satisfaction", "score"]);
});

test("the shortlist ranks by what matches the KPI, says why, and offers tables that share a column as related, not picked", () => {
  const s = shortlistTables(tables, "complaint volume");
  assert.equal(s.nothing_matched, false);
  assert.deepEqual(s.matches.map((m) => m.table), ["p.d.complaints"]);
  assert.ok(s.matches[0].why.some((w) => /name has "complaint"/.test(w)));
  assert.ok(s.matches[0].why.some((w) => /date column/.test(w)));
  assert.deepEqual(s.related, [{ table: "p.d.company_lookup", shares: "company", with: "p.d.complaints" }]);
  assert.ok(!s.matches.some((m) => m.table === "p.d.payments"));
});

test("a column name can carry the match, a name beats a column, and when nothing matches every table is offered", () => {
  const byCol = shortlistTables(tables, "payment amount");
  assert.equal(byCol.matches[0].table, "p.d.payments");
  assert.ok(byCol.matches[0].score > 3, "name and column both");
  const none = shortlistTables(tables, "weather");
  assert.equal(none.nothing_matched, true);
  assert.equal(none.matches.length, 4);
  assert.equal(shortlistTables(tables, "the of and").nothing_matched, true, "only stop words: nothing to match on");
});

const col = (name: string, o: Record<string, unknown>) => ({ name, type: "text", nulls: 0, distinct: 5, samples: [], roles: [], ...o });
const desc = (columns: unknown[], rows = 1000): DataDescription => ({ tables: [{ table: "t", rows, columns }], joins: [], hierarchies: [], time: [], ask: [] }) as unknown as DataDescription;

test("risks are read from the profile: test records, a rate that may be a fraction or a percent, empty dates", () => {
  const r = profileRisks(
    desc([
      col("status", { roles: ["concept"], samples: ["open", "TEST", "cancelled"] }),
      col("repeat_rate", { roles: ["measure"], min: 0, max: 0.93 }),
      col("success_pct", { roles: ["measure"], min: 3, max: 99 }),
      col("amount", { roles: ["measure"], min: 0, max: 0.5 }),
      col("created", { roles: ["time"], nulls: 120 }),
    ]),
  );
  assert.equal(r.length, 4);
  assert.match(r[0], /t\.status has values like "TEST", "cancelled"/);
  assert.match(r[1], /repeat_rate runs from 0 to 0\.93: is that a fraction/);
  assert.match(r[2], /success_pct runs from 3 to 99: is that a percent/);
  assert.match(r[3], /empty on 120 of 1000 rows \(12%\)/);
  assert.deepEqual(profileRisks(desc([col("status", { roles: ["concept"], samples: ["open", "closed"] })])), [], "clean values raise nothing");
});

test("data still arriving is noticed only when the newest days are far thinner than the typical day", () => {
  const days = (ns: number[]) => ns.map((n, i) => ({ day: `2026-03-${String(i + 1).padStart(2, "0")}`, n }));
  assert.equal(lateArrival(days([100, 98, 103, 101, 99, 102, 100, 99])), null);
  assert.match(lateArrival(days([100, 98, 103, 101, 99, 102, 100, 20]))!, /2026-03-08: 20 rows.*about 10\d rows/);
  assert.match(lateArrival(days([100, 98, 103, 101, 99, 102, 30, 20]))!, /newest days/);
  assert.equal(lateArrival(days([100, 20])), null, "too few days to judge");
  assert.equal(lateArrival(days([0, 0, 0, 0, 0, 0, 0, 5])), null, "no typical day to compare to");
});

test("the draft is plain sentences naming the table, the dates, the breakdowns and the links", () => {
  const d = {
    tables: [{ table: "complaints", rows: 4200000, columns: [col("date_received", { roles: ["time"] }), col("product", { roles: ["concept"] }), col("amount", { roles: ["measure"] }), col("timely", { roles: ["flag"] })] }],
    joins: [{ from: "complaints.company", to: "company_lookup.company", shape: "many_to_one", coverage: 0.98, unmatched_rows: 12 }],
    hierarchies: [{ table: "complaints", levels: ["product", "sub_product"] }],
    time: [{ table: "complaints", column: "date_received", from: "2011-12-01T00:00:00", to: "2026-03-01T00:00:00", days: 5000 }],
    ask: [],
  } as unknown as DataDescription;
  const s = draftSentences("complaint volume", d);
  assert.match(s[0], /"complaint volume" would be counted from complaints: 4,200,000 rows by date_received, from 2011-12-01 to 2026-03-01/);
  assert.ok(s.some((x) => /broken down by product/.test(x)));
  assert.ok(s.some((x) => /could be added up or averaged: amount/.test(x)));
  assert.ok(s.some((x) => /yes\/no columns: timely/.test(x)));
  assert.ok(s.some((x) => /product sits inside sub_product look nested/.test(x)));
  assert.ok(s.some((x) => /but 12 rows have no match/.test(x)));
});
