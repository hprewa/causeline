#!/usr/bin/env node
// D2 of the build guide: plant known faults in a copy of the (noisy) delivery data and see which the analysis finds. No model, no Toolbox.
//   node scripts/deliveries-inject.mjs [--seed 5] [--sizes 6] [--out file]
// The data is the deliveries pack's own generator with nothing planted by it (--no-fault), so the only faults are the ones planted here.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { calibrate, connectFiles, injectFaults, savePack, updateState } from "../core/builder/dist/src/index.js";
import { SqliteToolCaller } from "../core/builder/dist/src/sqlite-tools.js";
import { completeBuckets } from "../core/router/dist/src/index.js";
import { ToolIndex, loadPlaybook, runPlaybook } from "../core/runner/dist/src/index.js";
import { loadPack } from "../core/schema/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const flag = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const seed = Number(flag("seed", "5"));
const sizes = flag("sizes", "6").split(",").map(Number);
const out = resolve(flag("out", "docs/evidence/data/deliveries-inject.json"));
const py = process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");
const kpi = "on_time_rate";

const work = mkdtempSync(join(tmpdir(), "deliveries-inject-"));
try {
  const gen = spawnSync(py, [join(repo, "packs", "deliveries", "data", "generate.py"), "--seed", "42", "--no-fault", "--out-dir", join(work, "raw")], { encoding: "utf-8" });
  if (gen.status !== 0) throw new Error(gen.stderr);
  const ws = join(work, "ws");
  await connectFiles({ workspace: ws, files: [join(work, "raw", "orders.csv")] });
  const ontology = parse(readFileSync(join(repo, "packs", "deliveries", "ontology.yaml"), "utf-8"));
  const data = parse(readFileSync(join(repo, "packs", "deliveries", "data.yaml"), "utf-8"));
  delete data.source;
  const saved = await savePack({ workspace: ws, ontology, data });
  if (!saved.saved) throw new Error(saved.errors.join("; "));
  // reconciliation does not change what is found: record the rung the planting needs
  updateState(ws, (st) => {
    const c = (kind, start, end) => ({ id: `${kind}-1`, kind, scope: {}, window: { start, end }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" });
    st.kpis[kpi] = { level: "reconciled", checks: [c("total", "2026-06-01", "2026-06-07"), c("slice", "2026-06-01", "2026-06-07"), c("grain", "2026-06-08", "2026-06-08")], auto: { at: "now", pass: true, results: [] } };
  });
  // the replay over the data's own weeks: it says which weeks are ordinary, and the newest quiet one is where faults are planted
  const pack = loadPack(ws, { requireMeta: true });
  const index = new ToolIndex(pack.meta);
  const tools = new SqliteToolCaller(ws);
  const playbook = loadPlaybook("metric_change", ws);
  const cal = await calibrate({
    workspace: ws,
    kpi,
    makeTools: async () => tools,
    maxPeriods: 12,
    chunkMs: 10 * 60_000,
    deps: {
      baseline: 4,
      key: () => "deliveries",
      periods: () => completeBuckets(tools, index, kpi, pack.ontology.time.levels[0]),
      runOne: async (b) => ({ result: await runPlaybook({ playbook, ontology: pack.ontology, meta: pack.meta, tools, inputs: { metric: kpi, period: b.bucket, baseline: 4 } }) }),
    },
  });
  const ev = cal.evaluation;
  console.log(`replay: ${ev.alarms} of ${ev.judged} weeks judged raised something (${ev.judged} judged, 8 needed to calibrate)`);
  const runs = [];
  for (const sigmas of sizes) {
    const r = await injectFaults({ workspace: ws, kpi, seed, sigmas, chunkMs: 10 * 60_000 });
    if (r.stage !== "done") throw new Error(`fault planting did not run (${r.stage}): ${r.reasons.join("; ")}`);
    console.log(`planted in ${r.period?.label}`);
    const planted = r.outcomes.filter((o) => o.applicable);
    runs.push({ sigmas, control_quiet: r.control?.quiet, planted: planted.length, found: planted.filter((o) => o.pass).length, outcomes: r.outcomes.map((o) => ({ kind: o.kind, applicable: o.applicable, pass: o.pass, what: o.what, detail: o.detail })) });
    console.log(`size ${sigmas}: ${planted.filter((o) => o.pass).length} of ${planted.length} planted faults found (the unchanged week ${r.control?.quiet ? "raised nothing" : "RAISED SOMETHING"})`);
    for (const o of r.outcomes) console.log(`  ${o.kind}: ${!o.applicable ? "not plantable" : o.pass ? "found" : "MISSED"}  ${o.what ?? ""}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), kpi, data_seed: 42, plant_seed: seed, replay: { judged: ev.judged, alarms: ev.alarms, flagged: cal.flagged.map((f) => f.period) }, runs }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
