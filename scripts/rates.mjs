#!/usr/bin/env node
// The numbers behind the published rates, on synthetic contact-centre data (SQLite). For each of N seeds: 30 weeks of ordinary data with nothing
// planted; the false-alarm replay over its complete weeks (the analysis' own tools, no model, no Toolbox); then known faults planted in a copy of the
// newest quiet week, at several sizes, to see how often each kind is found and how that depends on size.
//   node scripts/rates.mjs [--seeds 8] [--weeks 30] [--sizes 2,3,4,6] [--out runs/calibration/rates.json]
// Writes JSON and prints markdown tables. The faults come from seeds the analysis was never tuned on; the hand-written eval cases are not used.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
const seeds = Number(flag("seeds", "8"));
const weeks = Number(flag("weeks", "30"));
const sizes = flag("sizes", "2,3,4,6").split(",").map(Number);
const out = resolve(flag("out", "runs/calibration/rates.json"));
const py = process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");

/** 95% interval for k of n (Wilson). */
function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}
const pct = (x) => `${(100 * x).toFixed(1)}%`;

const KINDS = ["segment_shift", "offsetting_pair", "mix_shift", "data_gap"];
const result = { when: new Date().toISOString(), seeds: [], weeks, sizes };

for (let s = 1; s <= seeds; s++) {
  const work = mkdtempSync(join(tmpdir(), `rates-${s}-`));
  try {
    const gen = spawnSync(py, [join(repo, "packs", "contact-centre", "data", "generate.py"), "--seed", String(1000 + s), "--weeks", String(weeks), "--out-dir", join(work, "raw")], { encoding: "utf-8" });
    if (gen.status !== 0) throw new Error(gen.stderr);
    const files = readdirSync(join(work, "raw")).filter((f) => f.endsWith(".csv")).map((f) => join(work, "raw", f));
    const ws = join(work, "ws");
    await connectFiles({ workspace: ws, files });
    const ontology = parse(readFileSync(join(repo, "packs", "contact-centre", "ontology.yaml"), "utf-8"));
    const data = parse(readFileSync(join(repo, "packs", "contact-centre", "data.yaml"), "utf-8"));
    delete ontology.metrics.workload;
    delete data.source;
    const saved = await savePack({ workspace: ws, ontology, data });
    if (!saved.saved) throw new Error(saved.errors.join("; "));
    // reconciliation does not change a false-alarm rate or a detection rate: record the rung the checks need
    updateState(ws, (st) => {
      const c = (kind, start, end) => ({ id: `${kind}-1`, kind, scope: {}, window: { start, end }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" });
      st.kpis.service_level = { level: "reconciled", checks: [c("total", "2026-01-05", "2026-01-11"), c("slice", "2026-01-05", "2026-01-11"), c("grain", "2026-01-12", "2026-01-12")], auto: { at: "now", pass: true, results: [] } };
    });
    const pack = loadPack(ws, { requireMeta: true });
    const index = new ToolIndex(pack.meta);
    const tools = new SqliteToolCaller(ws);
    const playbook = loadPlaybook("metric_change", ws);
    const cal = await calibrate({
      workspace: ws,
      kpi: "service_level",
      makeTools: async () => tools,
      maxPeriods: weeks,
      chunkMs: 10 * 60_000,
      deps: {
        baseline: 4,
        key: () => "rates",
        periods: () => completeBuckets(tools, index, "service_level", pack.ontology.time.levels[0]),
        runOne: async (b) => ({ result: await runPlaybook({ playbook, ontology: pack.ontology, meta: pack.meta, tools, inputs: { metric: "service_level", period: b.bucket, baseline: 4 } }) }),
      },
    });
    const ev = cal.evaluation;
    const rec = { seed: 1000 + s, judged: ev.judged, not_judged: ev.not_judged, alarms: ev.alarms, flagged: cal.flagged.map((f) => ({ period: f.period, what: f.what })), faults: [] };
    process.stderr.write(`seed ${s}: ${ev.alarms} of ${ev.judged} judged weeks raised something; ${ev.not_judged} declined\n`);
    for (const sigmas of sizes) {
      const r = await injectFaults({ workspace: ws, kpi: "service_level", seed: 7000 + s * 10 + sigmas, sigmas, chunkMs: 10 * 60_000 });
      for (const o of r.outcomes) rec.faults.push({ sigmas, kind: o.kind, applicable: o.applicable, pass: o.pass, what: o.what, detail: o.detail, control_quiet: r.control?.quiet });
      process.stderr.write(`  size ${sigmas}: ${r.outcomes.filter((o) => o.applicable && o.pass).length} of ${r.outcomes.filter((o) => o.applicable).length} found (control ${r.control?.quiet ? "quiet" : "NOT quiet"})\n`);
    }
    result.seeds.push(rec);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- the tables ------------------------------------------------------------------------------------------------------------------------
const judged = result.seeds.reduce((a, r) => a + r.judged, 0);
const alarms = result.seeds.reduce((a, r) => a + r.alarms, 0);
const declined = result.seeds.reduce((a, r) => a + r.not_judged, 0);
const [lo, hi] = wilson(alarms, judged);
const lines = [];
lines.push(`### False alarms, ${result.seeds.length} seeds of ${weeks} weeks with nothing planted`);
lines.push("");
lines.push(`| | weeks judged | raised something | rate | 95% interval | declined to judge |`);
lines.push(`|---|---|---|---|---|---|`);
for (const r of result.seeds) lines.push(`| seed ${r.seed} | ${r.judged} | ${r.alarms} | ${pct(r.alarms / Math.max(1, r.judged))} | | ${r.not_judged} |`);
lines.push(`| **all** | **${judged}** | **${alarms}** | **${pct(alarms / Math.max(1, judged))}** | ${pct(lo)} to ${pct(hi)} | ${declined} |`);
lines.push("");
lines.push(`### Planted faults found, by kind and size (found of planted; the unchanged week raised nothing in ${result.seeds.flatMap((r) => r.faults).filter((f) => f.control_quiet).length / KINDS.length} of ${result.seeds.length * sizes.length} runs)`);
lines.push("");
lines.push(`| kind | ${sizes.map((x) => `${x} standard errors`).join(" | ")} |`);
lines.push(`|---|${sizes.map(() => "---").join("|")}|`);
for (const kind of KINDS) {
  const cells = sizes.map((sg) => {
    const f = result.seeds.flatMap((r) => r.faults).filter((x) => x.kind === kind && x.sigmas === sg);
    const planted = f.filter((x) => x.applicable);
    const found = planted.filter((x) => x.pass).length;
    if (planted.length === 0) return `not plantable in ${f.length} of ${f.length}`;
    const [a, b] = wilson(found, planted.length);
    return `${found} of ${planted.length} (${pct(found / planted.length)}; ${pct(a)} to ${pct(b)})`;
  });
  lines.push(`| ${kind.replace(/_/g, " ")} | ${cells.join(" | ")} |`);
}
result.markdown = lines.join("\n");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(result.markdown);
console.log(`\nrows: ${out}`);
