#!/usr/bin/env node
// Spike for Phase 2 step 0: how often does the analysis raise something in ordinary, un-faulted history, under each candidate meaning of "alarm"?
//   node scripts/calibration-spike.mjs --pack packs/contact-centre --seeds 1,2,3,4,5,6 [--metrics service_level,aht] [--out file.json]
//   CAUSELINE_BQ_PROJECT=yukti-dev node scripts/calibration-spike.mjs --pack packs/complaints --metrics complaint_volume,timely_response_rate --periods 16
// Replays metric_change over every complete past period (a baseline of 4 periods first) and records what each run said. Nothing is written to the data.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { prepareCase } from "../core/eval/dist/src/index.js";
import { SdkToolCaller, ToolIndex, ToolboxProcess, findToolboxBinary, loadPackForRun, loadPlaybook, runPlaybook, toBuckets } from "../core/runner/dist/src/index.js";
import { withCostControl } from "../core/connect-bigquery/dist/src/index.js";

const flag = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const pack = resolve(flag("pack"));
const seeds = flag("seeds") ? flag("seeds").split(",") : [null];
const wanted = flag("metrics")?.split(",");
const lastN = Number(flag("periods", "0"));
const baseline = Number(flag("baseline", "4"));
const rows = [];

for (const seed of seeds) {
  const c = { id: `spike_${seed ?? "own"}`, ...(seed ? { setup: `--seed ${seed}` } : {}), question: "-", inputs: undefined, expect: {} };
  const workDir = await prepareCase(pack, c, join(tmpdir(), "calibration-spike", basename(pack)), false);
  const def = loadPackForRun(workDir);
  const server = await ToolboxProcess.start({ cwd: workDir, configDir: "toolbox", binary: findToolboxBinary() });
  const plain = new SdkToolCaller(server.url);
  const metered = def.data?.dialect === "bigquery" || process.env.CAUSELINE_BQ_PROJECT;
  const tools = plain; // lookups of extent and series are not part of a question
  const forRun = () => (metered ? withCostControl(workDir, plain) : plain); // each period is its own question, with its own budget
  try {
    const index = new ToolIndex(def.meta);
    const level = def.ontology.time.levels[0];
    for (const [metric, m] of Object.entries(def.ontology.metrics)) {
      if (m.type === "product" || (wanted && !wanted.includes(metric))) continue;
      const counts = (await tools.call(index.extent(metric), {}, "spike"))[0];
      const series = toBuckets(await tools.call(index.series(metric, level), { start: String(counts.min_ts), end: String(counts.max_ts) }, "spike"));
      const last = series[series.length - 1], before = series[series.length - 2];
      const full = last && before && last.den < 0.6 * before.den ? series.slice(0, -1) : series;
      const from = lastN > 0 ? Math.max(baseline, full.length - lastN) : baseline;
      for (let i = from; i < full.length; i++) {
        const t0 = Date.now();
        let r;
        try {
          r = await runPlaybook({ playbook: loadPlaybook("metric_change", workDir), ontology: def.ontology, meta: def.meta, tools: forRun(), inputs: { metric, period: full[i].bucket, baseline } });
        } catch (e) {
          rows.push({ seed, metric, period: full[i].bucket, error: String(e.message).slice(0, 160) });
          continue;
        }
        rows.push({
          seed, metric, period: full[i].bucket, status: r.status, stopped: r.stopped_reason ?? null,
          significant: r.headline?.significant === true, z: r.headline?.z ?? null, findings: r.findings.length,
          masks: r.masking_flags.filter((f) => f.type !== "small_cells").map((f) => f.type),
          bytes: r.cost?.bytes_scanned ?? 0, queries: r.cost?.queries ?? 0, ms: Date.now() - t0,
        });
        process.stderr.write(`${seed ?? "own"} ${metric} ${full[i].bucket}: ${r.status} sig=${r.headline?.significant} findings=${r.findings.length}\n`);
      }
    }
  } finally {
    await server.stop();
  }
}

const ok = rows.filter((x) => !x.error);
const defs = {
  "A: any finding, mask or stop (the backtest rule)": (x) => x.status === "stopped" || x.findings > 0 || x.masks.length > 0,
  "B: headline significant": (x) => x.significant,
  "C: headline significant and a finding": (x) => x.significant && x.findings > 0,
  "D: a finding, headline or not": (x) => x.findings > 0,
  "E: stopped": (x) => x.status === "stopped",
};
console.log(`\nperiods replayed: ${ok.length} (${rows.length - ok.length} errors)`);
for (const [name, f] of Object.entries(defs)) {
  const n = ok.filter(f).length;
  console.log(`${name.padEnd(52)} ${n}/${ok.length} = ${(100 * n / Math.max(1, ok.length)).toFixed(1)}%`);
}
for (const metric of [...new Set(ok.map((x) => x.metric))]) {
  const mm = ok.filter((x) => x.metric === metric);
  console.log(`  ${metric}: ${Object.entries(defs).map(([k, f]) => `${k[0]}=${mm.filter(f).length}/${mm.length}`).join("  ")}`);
}
console.log(`mean ms per period: ${Math.round(ok.reduce((s, x) => s + x.ms, 0) / Math.max(1, ok.length))}; bytes per period: ${Math.round(ok.reduce((s, x) => s + x.bytes, 0) / Math.max(1, ok.length) / 1e6)} MB`);
const out = flag("out");
if (out) {
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify(rows, null, 2));
  console.log(`rows: ${resolve(out)}`);
}
