import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgents, loadPack } from "@causeline/schema";
import { connectFiles } from "../src/connect.js";
import { assertReadOnlySelect } from "../src/sqlguard.js";
import { confirmPlayBack, describePack, playBack } from "../src/playback.js";
import { savePack } from "../src/savepack.js";
import { testFact } from "../src/testfact.js";
import { buildStatus, readState } from "../src/state.js";

test("only a single read-only SELECT is allowed, whatever is hidden in it", () => {
  assert.equal(assertReadOnlySelect("SELECT 1;"), "SELECT 1");
  assert.equal(assertReadOnlySelect("with a as (select 1) select * from a"), "with a as (select 1) select * from a");
  assert.equal(assertReadOnlySelect("SELECT 'drop table x; --' AS note"), "SELECT 'drop table x; --' AS note", "words inside a string are only text");
  for (const bad of ["DROP TABLE t", "SELECT 1; DROP TABLE t", "DELETE FROM t", "SELECT 1 /* x */; INSERT INTO t VALUES (1)", "PRAGMA table_info(t)", "ATTACH 'x.db' AS y", "UPDATE t SET a = 1", "", "SELECT load_extension('x')"]) {
    assert.throws(() => assertReadOnlySelect(bad), /SELECT|empty|read data|one SELECT/, bad);
  }
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "builder-pack-"));
  const csv = join(dir, "csv");
  mkdirSync(csv);
  writeFileSync(join(csv, "sites.csv"), "site,region\nA1,North\nA2,North\nB1,South\nB2,South\n");
  const rows = ["request_id,site,handled_at,on_time,cost"];
  for (let i = 1; i <= 80; i++) rows.push(`S${i},${["A1", "A2", "B1", "B2"][i % 4]},2026-01-${String((i % 28) + 1).padStart(2, "0")} 10:00:00,${i % 5 === 0 ? 0 : 1},${10 + (i % 7)}`);
  writeFileSync(join(csv, "requests.csv"), rows.join("\n") + "\n");
  return { ws: join(dir, "ws"), files: [join(csv, "sites.csv"), join(csv, "requests.csv")] };
}

const FACT = "SELECT s.request_id, s.handled_at AS ts, s.site, st.region, s.on_time, s.cost FROM requests s JOIN sites st ON st.site = s.site";
const draft = (over: { sql?: string; numerator?: string } = {}) => ({
  ontology: {
    time: { levels: ["week", "day"], seasonality: "none" },
    hierarchies: { location: ["region", "site"] },
    dimensions: [],
    metrics: { on_time_rate: { type: "ratio", direction: "higher_is_better", min_volume: 5, description: "Share of requests that arrived on time", synonyms: ["on time"] } },
  },
  data: {
    source: "ws-db",
    facts: { requests: { sql: over.sql ?? FACT, time: "ts", concepts: ["region", "site"] } },
    metrics: { on_time_rate: { fact: "requests", numerator: over.numerator ?? "on_time" } },
  },
  agents: [{ name: "on-time-rate-deep-rca", kpi: "on_time_rate", task: "deep_rca", examples: ["Why did on time drop?"] }],
});

test("test_fact runs a draft SELECT, says what it returns, and refuses anything else", async () => {
  const { ws, files } = workspace();
  await connectFiles({ workspace: ws, files });
  const ok = await testFact({ workspace: ws, sql: FACT, time: "ts", concepts: ["region", "site"] });
  assert.equal(ok.ok, true);
  assert.equal(ok.rows, 80);
  assert.deepEqual(ok.columns, ["request_id", "ts", "site", "region", "on_time", "cost"]);
  assert.equal(ok.sample.length, 5);
  assert.deepEqual(ok.warnings, []);
  const broken = await testFact({ workspace: ws, sql: "SELECT nope FROM requests" });
  assert.equal(broken.ok, false);
  assert.match(broken.error!, /no such column/);
  const evil = await testFact({ workspace: ws, sql: "DROP TABLE requests" });
  assert.match(evil.error!, /must be a SELECT|read data/);
  assert.equal((await testFact({ workspace: ws, sql: "SELECT COUNT(*) AS n FROM requests" })).sample[0].n, 80, "the table is still there");
  const missing = await testFact({ workspace: ws, sql: FACT, time: "when", concepts: ["country"] });
  assert.ok(missing.warnings.some((w) => /no column called when/.test(w)));
});

test("save_pack checks the draft against the data, writes the files and the tools, and notes what needs reconciling", async () => {
  const { ws, files } = workspace();
  await connectFiles({ workspace: ws, files });

  const bad = await savePack({ workspace: ws, ...draft({ sql: "SELECT * FROM nowhere" }) });
  assert.equal(bad.saved, false);
  assert.match(bad.errors.join(), /does not run on your data.*no such table/);
  assert.equal(existsSync(join(ws, "ontology.yaml")), false, "nothing is written while there are errors");

  const badFormula = await savePack({ workspace: ws, ...draft({ numerator: "on_tim" }) });
  assert.match(badFormula.errors.join(), /on_time_rate: its formula does not run/);

  const missingColumn = await savePack({ workspace: ws, ...draft({ sql: "SELECT handled_at AS ts, site, on_time FROM requests" }) });
  assert.match(missingColumn.errors.join(), /no column called region/);

  const ok = await savePack({ workspace: ws, ...draft() });
  assert.deepEqual([ok.saved, ok.errors], [true, []]);
  assert.ok(ok.tools! > 10);
  assert.deepEqual(ok.needs_reconciling, ["on_time_rate"]);
  assert.ok(existsSync(join(ws, "tools.meta.yaml")));
  assert.equal(loadPack(ws, { requireMeta: true }).ontology.metrics.on_time_rate.type, "ratio");
  assert.equal(loadAgents(ws)[0].status, "draft");
  assert.equal(readState(ws)!.kpis.on_time_rate.status, "tested");
  assert.match(readFileSync(join(ws, "data.yaml"), "utf-8"), /requests:/);

  const again = await savePack({ workspace: ws, ...draft() });
  assert.deepEqual(again.needs_reconciling, [], "an unchanged formula keeps what it earned");
  const changed = await savePack({ workspace: ws, ...draft({ numerator: "1 - on_time" }) });
  assert.deepEqual(changed.needs_reconciling, ["on_time_rate"]);
  assert.equal(buildStatus(ws).steps.find((s) => s.step.startsWith("KPI on_time_rate"))!.done, false);
});

test("a malformed draft is explained field by field, not thrown", async () => {
  const { ws, files } = workspace();
  await connectFiles({ workspace: ws, files });
  const r = await savePack({ workspace: ws, ontology: { time: { levels: ["week"] } }, data: { facts: {} } });
  assert.equal(r.saved, false);
  assert.ok(r.errors.some((e) => /ontology: .*seasonality/.test(e)));
  assert.ok(r.errors.some((e) => /^data: /.test(e)));
});

test("play_back says the pack in sentences, and shows what changed since the user confirmed", async () => {
  const { ws, files } = workspace();
  await connectFiles({ workspace: ws, files });
  await savePack({ workspace: ws, ...draft() });
  const first = playBack(ws);
  const text = first.sentences.map((s) => s.text).join("\n");
  assert.match(text, /Questions are asked about one week at a time/);
  assert.match(text, /location, from the broadest to the finest: region, then site \(each site belongs to one region\)/);
  assert.match(text, /on time rate \(Share of requests that arrived on time\) is the average of "on time", taken over every "requests" record/);
  assert.match(text, /which is built from requests and sites/);
  assert.match(text, /Nothing repeats in a way that matters/);
  assert.match(text, /Expert "on-time-rate-deep-rca" answers deep rca questions about on time rate/);
  assert.doesNotMatch(text, /SELECT|JOIN/, "no SQL in what the user reads");
  assert.deepEqual(first.sentences.map((s) => s.n), first.sentences.map((_, i) => i + 1));
  assert.equal(first.confirmed, false);

  assert.equal(confirmPlayBack(ws).confirmed, true);
  await savePack({ workspace: ws, ...draft({ numerator: "1 - on_time" }) });
  const after = playBack(ws);
  assert.equal(after.confirmed, false);
  assert.ok(after.changes.added.some((t) => /1 - on_time/.test(t)));
  assert.ok(after.changes.removed.some((t) => /"on time"/.test(t)));
});

test("a shipped pack reads as sentences a person can follow", () => {
  const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packs"), "contact-centre");
  const p = loadPack(dir);
  const sentences = describePack(p.ontology, p.data, loadAgents(dir));
  assert.ok(sentences.length >= 8);
  assert.ok(sentences.every((s) => s.length > 20 && !/\bSELECT\b/i.test(s)), "no SQL in the sentences");
  const text = sentences.join("\n");
  assert.match(text, /service level .* is the average of "answered within 20s"/);
  assert.match(text, /Days flagged "is holiday" are only compared with other days flagged the same way/);
});

test("saving never makes an expert verified, and never unverifies one whose KPI did not change", async () => {
  const { ws, files } = workspace();
  await connectFiles({ workspace: ws, files });
  const claims = { ...draft(), agents: [{ name: "on-time-rate-deep-rca", kpi: "on_time_rate", task: "deep_rca", status: "verified", examples: ["why?"] }] };
  await savePack({ workspace: ws, ...claims });
  assert.equal(loadAgents(ws)[0].status, "draft", "a draft cannot claim to be verified");

  // verification happens elsewhere (verify_expert); simulate its result on disk
  const file = join(ws, "agents", "on-time-rate-deep-rca.yaml");
  writeFileSync(file, readFileSync(file, "utf-8").replace("status: draft", "status: verified"));
  assert.equal(loadAgents(ws)[0].status, "verified");
  const again = await savePack({ workspace: ws, ...draft() });
  assert.equal(loadAgents(ws)[0].status, "verified", "saved again with the same formula: still verified");
  assert.deepEqual(again.warnings.filter((w) => /draft again/.test(w)), []);

  const changed = await savePack({ workspace: ws, ...draft({ numerator: "1 - on_time" }) });
  assert.equal(loadAgents(ws)[0].status, "draft");
  assert.ok(changed.warnings.some((w) => /draft again because on_time_rate changed/.test(w)));
});

test("an evidence source is checked against the data like everything else", async () => {
  const { ws, files } = workspace();
  await connectFiles({ workspace: ws, files });
  const base = draft();
  const withEvidence = (sql: string, about = ["site"]) => ({ ...base, data: { ...base.data, evidence: { request_log: { sql, time: "handled_at", about } } } });
  const ok = await savePack({ workspace: ws, ...withEvidence("SELECT site, handled_at, cost FROM requests") });
  assert.equal(ok.saved, true, ok.errors.join());
  const broken = await savePack({ workspace: ws, ...withEvidence("SELECT site FROM nowhere") });
  assert.match(broken.errors.join(), /evidence "request_log" does not run on your data/);
  const missingColumn = await savePack({ workspace: ws, ...withEvidence("SELECT handled_at, cost FROM requests") });
  assert.match(missingColumn.errors.join(), /evidence "request_log": there is no column called site/);
});
