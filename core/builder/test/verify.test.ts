import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { EvalCases, loadAgents } from "@causeline/schema";
import { connectFiles } from "../src/connect.js";
import { savePack } from "../src/savepack.js";
import { readState, updateState } from "../src/state.js";
import { normaliseExpected } from "../src/checks.js";
import { addIncident, verifyExpert } from "../src/verify.js";

test("a percentage said as 93.1 is the fraction 0.931 for a rate, and left alone otherwise", () => {
  assert.equal(normaliseExpected(93.1, true, 0.931), 0.931);
  assert.equal(normaliseExpected(0.931, true, 0.931), 0.931);
  assert.equal(normaliseExpected(93.1, false, 93.12), 93.1);
  assert.equal(normaliseExpected(250, true, 250), 250, "a rate that is not a fraction (seconds) is not a percentage");
});

async function savedWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "builder-verify-"));
  const csv = join(dir, "events.csv");
  const rows = ["event_id,site,happened_at,ok"];
  for (let i = 1; i <= 60; i++) rows.push(`E${i},${i % 2 ? "north" : "south"},2026-01-${String((i % 28) + 1).padStart(2, "0")} 09:00:00,${i % 4 ? 1 : 0}`);
  writeFileSync(csv, rows.join("\n") + "\n");
  const ws = join(dir, "ws");
  await connectFiles({ workspace: ws, files: [csv] });
  const r = await savePack({
    workspace: ws,
    ontology: { time: { levels: ["week", "day"], seasonality: "none" }, hierarchies: {}, dimensions: ["site"], metrics: { ok_rate: { type: "ratio", direction: "higher_is_better", min_volume: 5 } } },
    data: { source: "ws-db", facts: { events: { sql: "SELECT event_id, happened_at AS ts, site, ok FROM events", time: "ts", concepts: ["site"] } }, metrics: { ok_rate: { fact: "events", numerator: "ok" } } },
  });
  assert.equal(r.saved, true, r.errors.join());
  return ws;
}

test("an incident becomes an eval case against the real data, and is remembered", async () => {
  const ws = await savedWorkspace();
  const r = addIncident({ workspace: ws, kpi: "ok_rate", period: "2026-W03", finding: { dimension: "site", value: "north" }, question: "Why did the ok rate drop in week 3?", mention: ["north"] });
  assert.equal(r.id, "incident_1_ok_rate");
  const cases = EvalCases.parse(parse(readFileSync(join(ws, "evals", "cases.yaml"), "utf-8")));
  assert.equal(cases[0].setup, undefined, "no setup: it runs on the pack as it is");
  assert.deepEqual(cases[0].inputs, { metric: "ok_rate", period: "2026-W03", playbook: "metric_change" });
  assert.deepEqual(cases[0].expect.top_finding, { dimension: "site", value: "north" });
  assert.equal(readState(ws)!.incidents.length, 1);
  assert.throws(() => addIncident({ workspace: ws, kpi: "ok_rate", period: "2026-W03", finding: { dimension: "planet", value: "x" }, question: "q" }), /not something this pack can break a KPI down by/);
  assert.throws(() => addIncident({ workspace: ws, kpi: "ghost", period: "2026-W03", finding: { dimension: "site", value: "x" }, question: "q" }), /not a KPI/);
});

test("an expert cannot become verified without a matched number and a recorded incident", async () => {
  const ws = await savedWorkspace();
  const none = await verifyExpert({ workspace: ws, kpi: "ok_rate" });
  assert.equal(none.verified, false);
  assert.match(none.reasons.join("; "), /is not verified yet \(it is draft\)/);
  assert.match(none.reasons.join("; "), /no past incident is recorded/);

  updateState(ws, (s) => {
    const check = (kind: "total" | "slice") => ({ id: `${kind}-1`, kind, scope: {}, window: { start: "2026-01-05", end: "2026-01-11" }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" as const });
    s.kpis.ok_rate = { level: "verified", checks: [check("total"), check("slice")], auto: { at: "now", pass: true, results: [] } };
  });
  const noIncident = await verifyExpert({ workspace: ws, kpi: "ok_rate" });
  assert.deepEqual(noIncident.reasons.length, 1);
  assert.match(noIncident.reasons[0], /no past incident/);
  assert.equal(existsSync(join(ws, "agents")) && loadAgents(ws).some((a) => a.status === "verified"), false, "nothing was marked verified");
});

test("an incident can be given as dates, and is run as a date range", async () => {
  const ws = await savedWorkspace();
  const r = addIncident({ workspace: ws, kpi: "ok_rate", period: "", start_date: "2026-01-12", end_date: "2026-01-18", finding: { dimension: "site", value: "north" }, question: "Why did the ok rate drop in the week of 12 January?" });
  const cases = EvalCases.parse(parse(readFileSync(join(ws, "evals", "cases.yaml"), "utf-8")));
  assert.deepEqual(cases.find((c) => c.id === r.id)!.inputs, { metric: "ok_rate", period: "", playbook: "metric_change", more: { start_date: "2026-01-12", end_date: "2026-01-18" } });
  assert.throws(() => addIncident({ workspace: ws, kpi: "ok_rate", period: "", finding: { dimension: "site", value: "north" }, question: "q" }), /say when it happened/);
});

test("an incident can ask only that the culprit is among the findings", async () => {
  const ws = await savedWorkspace();
  const r = addIncident({ workspace: ws, kpi: "ok_rate", period: "2026-W03", finding: { dimension: "site", value: "north" }, question: "Why?", anywhere: true });
  const c = EvalCases.parse(parse(readFileSync(join(ws, "evals", "cases.yaml"), "utf-8"))).find((x) => x.id === r.id)!;
  assert.equal(c.expect.top_finding, undefined);
  assert.deepEqual(c.expect.findings_include, [{ dimension: "site", value: "north" }]);
});
