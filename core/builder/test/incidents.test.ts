import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack } from "@causeline/schema";
import { ToolIndex, type Row, type ToolCaller } from "@causeline/runner";
import type { Result } from "@causeline/schema";
import { calibrate } from "../src/calibrate.js";
import { connectFiles } from "../src/connect.js";
import { proposeIncident } from "../src/incident-import.js";
import { savePack } from "../src/savepack.js";
import { newState, readState, updateState, writeState } from "../src/state.js";
import { addIncident } from "../src/verify.js";

async function savedWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "builder-incidents-"));
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

/** The data as the tools would give it: eight whole weeks, their days, and two sites that were active (one of them only in week 3). */
function stubTools(ws: string): ToolCaller {
  const index = new ToolIndex(loadPack(ws, { requireMeta: true }).meta!);
  const day = (i: number) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
  const weekRows = Array.from({ length: 8 }, (_, w) => ({ bucket: `2026-W${String(w + 1).padStart(2, "0")}`, bucket_start: `${day(w * 7)} 00:00:00`, bucket_end: `${day(w * 7 + 6)} 23:59:59`, num: 40, den: 50 }));
  const dayRows = Array.from({ length: 56 }, (_, d) => ({ bucket: day(d), bucket_start: `${day(d)} 00:00:00`, bucket_end: `${day(d)} 23:59:59`, num: 6, den: 7 }));
  return {
    call: async (tool: string, params: Record<string, string>): Promise<Row[]> => {
      if (tool === index.extent("ok_rate")) return [{ min_ts: `${day(0)} 00:00:00`, max_ts: `${day(55)} 23:59:59`, n_rows: 400 }];
      if (tool === index.series("ok_rate", "week")) return weekRows;
      if (tool === index.series("ok_rate", "day")) return dayRows;
      if (tool === index.slice("ok_rate", "site")) {
        const inWeek3 = String(params.cur_start).startsWith(day(14));
        return [
          { node: "north", cur_num: 20, cur_den: 25, base_num: 20, base_den: 25 },
          { node: "south", cur_num: 20, cur_den: 25, base_num: 20, base_den: 25 },
          ...(inWeek3 ? [{ node: "east", cur_num: 1, cur_den: 5, base_num: 1, base_den: 5 }] : []),
        ] as Row[];
      }
      throw new Error(`the stub has no answer for ${tool}`);
    },
  } as unknown as ToolCaller;
}

test("the first incident of a KPI can help set the analysis up; later ones are kept aside; the person can say otherwise", async () => {
  const ws = await savedWorkspace();
  const a = addIncident({ workspace: ws, kpi: "ok_rate", period: "2026-W03", finding: { dimension: "site", value: "north" }, question: "Why did the ok rate drop in week 3?" });
  const b = addIncident({ workspace: ws, kpi: "ok_rate", period: "2026-W05", finding: { dimension: "site", value: "south" }, question: "Why did the ok rate drop in week 5?" });
  const c = addIncident({ workspace: ws, kpi: "ok_rate", period: "2026-W06", finding: { dimension: "site", value: "south" }, question: "And in week 6?", held_out: false });
  assert.deepEqual([a.held_out, b.held_out, c.held_out], [false, true, false]);
  assert.deepEqual(readState(ws)!.incidents.map((i) => i.held_out), [false, true, false]);
});

test("a described incident is placed in the data and turned into the exact record to make; the first can help, the next is kept aside", async () => {
  const ws = await savedWorkspace();
  const tools = stubTools(ws);
  const first = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, period_words: "week 3", finding: { dimension: "site", value: "north" }, question: "Why did the ok rate drop in week 3?", text: "On the 19th the north site lost power." });
  assert.equal(first.ok, true, first.problems.join(" "));
  assert.deepEqual(first.add_incident, { kpi: "ok_rate", period: "2026-W03", finding: { dimension: "site", value: "north" }, question: "Why did the ok rate drop in week 3?", held_out: false });
  assert.match(first.say, /It is the first one, so it can help/);
  addIncident({ workspace: ws, ...(first.add_incident as object) } as never);
  const next = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, period_words: "week 5", finding: { dimension: "site", value: "SOUTH" }, text: "South had a long outage in week 5." });
  assert.equal(next.ok, true, next.problems.join(" "));
  assert.equal(next.held_out, true);
  assert.equal((next.add_incident!.finding as { value: string }).value, "south", "the value is corrected to the real spelling");
  assert.match(next.say, /kept aside: it is only looked at at the end/);
  assert.match(String(next.add_incident!.question), /Why did ok rate change/);
});

test("what cannot be placed is said, with the real values, and nothing is made up", async () => {
  const ws = await savedWorkspace();
  const tools = stubTools(ws);
  const noPlace = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, period_words: "week 3", finding: { dimension: "site", value: "west" }, question: "q" });
  assert.equal(noPlace.ok, false);
  assert.equal(noPlace.add_incident, undefined);
  assert.deepEqual(noPlace.suggestions!.values.slice(0, 2), ["north", "south"]);
  assert.match(noPlace.problems[0], /"west" is not a site that has any activity in/);

  const noDimension = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, period_words: "week 3", finding: { dimension: "planet", value: "x" }, question: "q" });
  assert.match(noDimension.problems.join(" "), /"planet" is not something this data can be broken down by/);

  const noWhen = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, finding: { dimension: "site", value: "north" }, question: "q" });
  assert.match(noWhen.problems.join(" "), /When did it happen/);

  const lost = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, period_words: "sometime last spring", finding: { dimension: "site", value: "north" }, question: "q" });
  assert.match(lost.problems.join(" "), /could not tell which week "sometime last spring" means/);

  const outside = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, start_date: "2025-01-01", end_date: "2025-01-07", finding: { dimension: "site", value: "north" }, question: "q" });
  assert.match(outside.problems.join(" "), /outside the data, which covers/);
  const backwards = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, start_date: "2026-01-20", end_date: "2026-01-10", finding: { dimension: "site", value: "north" }, question: "q" });
  assert.match(backwards.problems.join(" "), /first day is after the last day/);
  const sloppy = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools, start_date: "19 January", end_date: "20 January", finding: { dimension: "site", value: "north" }, question: "q" });
  assert.match(sloppy.problems.join(" "), /written YYYY-MM-DD/);
});

test("dates are accepted and become a date range, not a period", async () => {
  const ws = await savedWorkspace();
  const p = await proposeIncident({ workspace: ws, kpi: "ok_rate", tools: stubTools(ws), start_date: "2026-01-19", end_date: "2026-01-25", finding: { dimension: "site", value: "north" }, question: "Why did the ok rate drop in the week of 19 January?" });
  assert.equal(p.ok, true, p.problems.join(" "));
  assert.deepEqual(p.add_incident, { kpi: "ok_rate", period: "", start_date: "2026-01-19", end_date: "2026-01-25", finding: { dimension: "site", value: "north" }, question: "Why did the ok rate drop in the week of 19 January?", held_out: false });
});

test("an incident kept aside never reaches the calibration: what it keeps and says holds nothing of it", async () => {
  const ws = mkdtempSync(join(tmpdir(), "builder-aside-"));
  writeState(ws, newState("x"));
  updateState(ws, (st) => {
    const check = (kind: "total" | "slice" | "grain", start: string, end: string) => ({ id: `${kind}-1`, kind, scope: {}, window: { start, end }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" as const });
    st.kpis.ok = { level: "reconciled", checks: [check("total", "2026-01-05", "2026-01-11"), check("slice", "2026-01-05", "2026-01-11"), check("grain", "2026-01-12", "2026-01-12")], auto: { at: "now", pass: true, results: [] } };
    st.incidents.push({ id: "incident_1_ok", kpi: "ok", text: "THE-SECRET-WORDING-OF-THE-KEPT-ASIDE-INCIDENT", held_out: true });
  });
  const quiet = { status: "complete", headline: { z: 0, significant: false }, findings: [], masking_flags: [] } as unknown as Result;
  const weeks = Array.from({ length: 16 }, (_, i) => ({ bucket: `2026-W${String(i + 1).padStart(2, "0")}`, bucket_start: new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10), bucket_end: new Date(Date.UTC(2026, 0, 11 + i * 7)).toISOString().slice(0, 10), num: 1, den: 1 }));
  const report = await calibrate({ workspace: ws, kpi: "ok", makeTools: async () => ({}) as never, deps: { baseline: 4, key: () => "k", periods: async () => weeks, runOne: async () => ({ result: quiet }) } });
  assert.doesNotMatch(JSON.stringify(report), /THE-SECRET-WORDING/);
  assert.doesNotMatch(readFileSync(join(ws, "calibration-ok.json"), "utf-8"), /THE-SECRET-WORDING|incident_1_ok/);
});
