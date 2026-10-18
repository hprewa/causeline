import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferColumn, parseCsv, slug } from "../src/csv.js";
import { connectFiles } from "../src/connect.js";
import { describeData } from "../src/profile.js";
import { buildStatus } from "../src/state.js";

test("csv: quotes, escaped quotes, commas and newlines inside fields, CRLF and a BOM", () => {
  const { header, rows } = parseCsv('﻿name,note\r\n"Smith, J","said ""hi""\nthere"\r\nplain,\r\n');
  assert.deepEqual(header, ["name", "note"]);
  assert.deepEqual(rows, [["Smith, J", 'said "hi"\nthere'], ["plain", ""]]);
});

test("types come from all the values: integers, reals, ISO and slash dates, and text", () => {
  assert.equal(inferColumn(["1", "2", "", "30"]).type, "integer");
  assert.equal(inferColumn(["1", "2.5"]).type, "real");
  assert.equal(inferColumn(["007", "012"]).type, "text", "leading zeros are identifiers, not numbers");
  assert.equal(inferColumn(["2026-01-05", "2026-02-01"]).type, "date");
  const dt = inferColumn(["2026-01-05T08:30:00Z", "2026-01-05 09:00"]);
  assert.equal(dt.type, "datetime");
  assert.equal(dt.convert("2026-01-05T08:30:00Z"), "2026-01-05 08:30:00");
  const dayFirst = inferColumn(["25/01/2026", "03/02/2026"]);
  assert.equal(dayFirst.type, "date");
  assert.equal(dayFirst.convert("03/02/2026"), "2026-02-03");
  assert.match(dayFirst.note!, /day\/month\/year/);
  const ambiguous = inferColumn(["01/02/2026", "03/04/2026"]);
  assert.equal(ambiguous.type, "text");
  assert.match(ambiguous.note!, /cannot be told/);
  assert.equal(inferColumn(["1", "x"]).type, "text");
});

test("names become plain identifiers", () => {
  assert.equal(slug("Order Date"), "order_date");
  assert.equal(slug("siteID"), "site_id");
  assert.equal(slug("2nd place"), "c_2nd_place");
});

function workspaceWithCsvs() {
  const dir = mkdtempSync(join(tmpdir(), "builder-"));
  const csv = join(dir, "csv");
  mkdirSync(csv);
  // 40 requests across 4 sites in 2 regions, each request due by a date; a flag and a cost
  const sites = ["A1", "A2", "B1", "B2"];
  const region = { A1: "North", A2: "North", B1: "South", B2: "South" } as Record<string, string>;
  writeFileSync(join(csv, "Sites.csv"), "Site,Region\n" + sites.map((s) => `${s},${region[s]}`).join("\n") + "\n");
  const rows = ["Request ID,Site,Handled At,On Time,Cost"];
  for (let i = 1; i <= 40; i++) rows.push(`S${i},${sites[i % 4]},2026-01-${String((i % 28) + 1).padStart(2, "0")} 10:00:00,${i % 5 === 0 ? 0 : 1},${(10 + i / 3).toFixed(2)}`);
  writeFileSync(join(csv, "requests.csv"), rows.join("\n") + "\n");
  return { dir, ws: join(dir, "workspace"), files: [join(csv, "Sites.csv"), join(csv, "requests.csv")] };
}

test("connecting files makes a database, a Toolbox source and a build state, and says what it changed", async () => {
  const { ws, files } = workspaceWithCsvs();
  const r = await connectFiles({ workspace: ws, files });
  assert.deepEqual(r.tables.map((t) => [t.table, t.rows]), [["sites", 4], ["requests", 40]]);
  const ship = r.tables.find((t) => t.table === "requests")!;
  assert.deepEqual(ship.columns.map((c) => [c.name, c.type]), [["request_id", "text"], ["site", "text"], ["handled_at", "datetime"], ["on_time", "integer"], ["cost", "real"]]);
  assert.ok(r.notes.some((n) => /column "Request ID" is called request_id/.test(n)));
  assert.match(readFileSync(join(ws, "toolbox", "source.yaml"), "utf-8"), /type: sqlite[\s\S]*data\/causeline\.db/);
  assert.equal(buildStatus(ws).steps[0].done, true);
  assert.match(buildStatus(ws).next, /describe_data/);
});

test("describe_data finds the time column, the flag, the measure, the join and the hierarchy", async () => {
  const { ws, files } = workspaceWithCsvs();
  await connectFiles({ workspace: ws, files });
  const d = await describeData(ws);
  const ship = d.tables.find((t) => t.table === "requests")!;
  const role = (name: string) => ship.columns.find((c) => c.name === name)!.roles;
  assert.ok(role("handled_at").includes("time"));
  assert.ok(role("on_time").includes("flag"));
  assert.ok(role("cost").includes("measure"));
  assert.ok(role("request_id").includes("key"));
  assert.ok(role("site").includes("concept"));
  assert.deepEqual(d.time.map((t) => `${t.table}.${t.column}`), ["requests.handled_at"]);
  const join = d.joins.find((j) => j.from === "requests.site");
  assert.deepEqual([join?.to, join?.shape, join?.coverage, join?.unmatched_rows], ["sites.site", "many_to_one", 1, 0]);
  assert.deepEqual(d.hierarchies, [{ table: "sites", levels: ["region", "site"] }]);
  assert.equal(buildStatus(ws).steps[1].done, true);
});

test("describe_data asks instead of guessing: two date columns, and rows with no match", async () => {
  const { dir, ws } = workspaceWithCsvs();
  const odd = join(dir, "csv", "jobs.csv");
  writeFileSync(odd, "job_id,site,ordered,due\n1,A1,2026-01-01,2026-01-03\n2,A2,2026-01-02,2026-01-04\n3,ZZ,2026-01-02,2026-01-04\n");
  await connectFiles({ workspace: ws, files: [join(dir, "csv", "Sites.csv"), odd] });
  const d = await describeData(ws);
  assert.ok(d.ask.some((a) => /jobs has 2 date columns \(ordered, due\)/.test(a)));
  assert.ok(d.ask.some((a) => /1 rows of jobs\.site have no match in sites\.site/.test(a)));
});

test("a non-CSV file and a missing file are refused in plain words", async () => {
  const { dir, ws } = workspaceWithCsvs();
  writeFileSync(join(dir, "x.xlsx"), "not really");
  await assert.rejects(connectFiles({ workspace: ws, files: [join(dir, "x.xlsx")] }), /not a CSV file/);
  await assert.rejects(connectFiles({ workspace: ws, files: [join(dir, "nope.csv")] }), /does not exist/);
});
