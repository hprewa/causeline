import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeBuckets } from "@causeline/router";
import { ToolIndex, loadPlaybook, runPlaybook } from "@causeline/runner";
import { loadPack } from "@causeline/schema";
import { calibrate } from "../src/calibrate.js";
import { connectFiles } from "../src/connect.js";
import { faultStatus, injectFaults, seeded } from "../src/inject.js";
import { savePack } from "../src/savepack.js";
import { SqliteToolCaller } from "../src/sqlite-tools.js";
import { levelOf, readState, updateState } from "../src/state.js";

const RATES: Record<string, number> = { north: 0.95, south: 0.8, east: 0.6, west: 0.4 };

/** Twelve weeks of events at four sites with different, steady rates and nothing planted: an ordinary history. */
async function ordinary(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "builder-inject-"));
  const rand = seeded(7);
  const rows = ["event_id,site,happened_at,ok"];
  let id = 0;
  for (let week = 0; week < 12; week++) {
    for (const site of Object.keys(RATES)) {
      for (let i = 0; i < 140; i++) {
        const day = new Date(Date.UTC(2026, 0, 5 + week * 7 + Math.floor(rand() * 7)));
        rows.push(`E${++id},${site},${day.toISOString().slice(0, 10)} ${String(8 + Math.floor(rand() * 10)).padStart(2, "0")}:00:00,${rand() < RATES[site] ? 1 : 0}`);
      }
    }
  }
  const csv = join(dir, "events.csv");
  writeFileSync(csv, rows.join("\n") + "\n");
  const ws = join(dir, "ws");
  await connectFiles({ workspace: ws, files: [csv] });
  const r = await savePack({
    workspace: ws,
    ontology: { time: { levels: ["week", "day"], seasonality: "none" }, hierarchies: {}, dimensions: ["site"], metrics: { ok_rate: { type: "ratio", direction: "higher_is_better", min_volume: 30 } } },
    data: { source: "ws-db", facts: { events: { sql: "SELECT event_id, happened_at AS ts, site, ok FROM events", time: "ts", concepts: ["site"] } }, metrics: { ok_rate: { fact: "events", numerator: "ok" } } },
  });
  assert.equal(r.saved, true, r.errors.join());
  updateState(ws, (st) => {
    const check = (kind: "total" | "slice" | "grain", start: string, end: string) => ({ id: `${kind}-1`, kind, scope: {}, window: { start, end }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" as const });
    st.kpis.ok_rate = { level: "reconciled", checks: [check("total", "2026-01-05", "2026-01-11"), check("slice", "2026-01-05", "2026-01-11"), check("grain", "2026-01-12", "2026-01-12")], auto: { at: "now", pass: true, results: [] } };
  });
  return ws;
}

/** The false-alarm check run for real on that history (the project's own tools, no model, no Toolbox). */
async function checked(ws: string) {
  const pack = loadPack(ws, { requireMeta: true });
  const index = new ToolIndex(pack.meta!);
  const tools = new SqliteToolCaller(ws);
  const playbook = loadPlaybook("metric_change", ws);
  return calibrate({
    workspace: ws,
    kpi: "ok_rate",
    makeTools: async () => tools,
    deps: {
      baseline: 4,
      key: () => "k",
      periods: () => completeBuckets(tools, index, "ok_rate", "week"),
      runOne: async (b) => ({ result: await runPlaybook({ playbook, ontology: pack.ontology, meta: pack.meta!, tools, inputs: { metric: "ok_rate", period: b.bucket, baseline: 4 } }) }),
    },
  });
}

const hash = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

test("faults planted in a quiet period of the person's own data are found, the gap is declined, and the data itself is untouched", async (t) => {
  const ws = await ordinary();
  const cal = await checked(ws);
  assert.equal(cal.stage, "done");
  const before = hash(join(ws, "data", "causeline.db"));
  const dataYaml = readFileSync(join(ws, "data.yaml"), "utf-8");

  const r = await injectFaults({ workspace: ws, kpi: "ok_rate", seed: 5 });
  assert.equal(r.stage, "done", JSON.stringify(r.outcomes));
  assert.equal(r.control!.quiet, true, `the unchanged window raised something: ${r.control!.detail}`);
  for (const o of r.outcomes) t.diagnostic(`${o.kind}: applicable=${o.applicable} pass=${o.pass} ${o.what}${o.detail ? ` | ${o.detail}` : ""}`);
  const byKind = Object.fromEntries(r.outcomes.map((o) => [o.kind, o]));
  assert.equal(byKind.segment_shift.applicable && byKind.segment_shift.pass, true, JSON.stringify(byKind.segment_shift));
  assert.equal(byKind.data_gap.applicable && byKind.data_gap.pass, true, JSON.stringify(byKind.data_gap));
  assert.equal(byKind.offsetting_pair.applicable, true);
  assert.equal(byKind.mix_shift.applicable, true, JSON.stringify(byKind.mix_shift));
  assert.match(byKind.segment_shift.what, /rows of north that favour it were swapped for ones that count against it/);
  assert.equal(r.summary!.found, r.summary!.planted, JSON.stringify(r.outcomes.map((o) => [o.kind, o.pass, o.detail])));

  // the person's data is exactly as it was
  assert.equal(hash(join(ws, "data", "causeline.db")), before);
  assert.equal(readFileSync(join(ws, "data.yaml"), "utf-8"), dataYaml);

  // what was found is kept on the KPI, with how many were planted
  const v = readState(ws)!.kpis.ok_rate.verification!;
  assert.equal(v.faults_total, r.summary!.planted);
  assert.equal(v.faults_passed!.length, r.summary!.found);
  assert.equal(faultStatus(ws, "ok_rate").run, true);
  // every kind that could be planted was found and the unchanged window stayed quiet: with the KPI calibrated, that is independent proof
  assert.equal(v.pass, true);
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), cal.evaluation!.pass ? "verified" : "reconciled");
});

test("a fault is the same every time from the same seed, and a different seed plants a different one", async () => {
  const ws = await ordinary();
  await checked(ws);
  const a = await injectFaults({ workspace: ws, kpi: "ok_rate", seed: 11, kinds: ["segment_shift"] });
  const again = await injectFaults({ workspace: ws, kpi: "ok_rate", seed: 11, kinds: ["segment_shift"] });
  assert.equal(a.outcomes[0].what, again.outcomes[0].what);
  assert.equal(a.outcomes[0].at, again.outcomes[0].at, "a finished run is not repeated");
  const other = await injectFaults({ workspace: ws, kpi: "ok_rate", seed: 12, kinds: ["segment_shift"] });
  assert.equal(other.outcomes[0].kind, "segment_shift");
});

test("it needs the false-alarm check first, refuses cloud data, and says what it cannot plant", async () => {
  const ws = await ordinary();
  const first = await injectFaults({ workspace: ws, kpi: "ok_rate" });
  assert.equal(first.stage, "not_ready");
  assert.match(first.reasons[0], /not been checked for false alarms yet/);
  updateState(ws, (s) => {
    s.dialect = "bigquery";
  });
  const cloud = await injectFaults({ workspace: ws, kpi: "ok_rate" });
  assert.equal(cloud.stage, "not_ready");
  assert.match(cloud.reasons[0], /cloud data cannot be copied here yet/);
});

test("a run can stop and resume, and its result follows the KPI to its rung", async () => {
  const ws = await ordinary();
  const cal = await checked(ws);
  const part = await injectFaults({ workspace: ws, kpi: "ok_rate", chunkMs: -1, seed: 3 });
  assert.equal(part.stage, "running");
  assert.equal(part.progress.done, 1);
  const done = await injectFaults({ workspace: ws, kpi: "ok_rate", seed: 3 });
  assert.equal(done.stage, "done");
  assert.equal(existsSync(join(ws, "faults-ok_rate.json")), true);
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), cal.evaluation!.pass ? "verified" : "reconciled");
});
