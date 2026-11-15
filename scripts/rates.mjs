#!/usr/bin/env node
// The numbers behind the published rates, on synthetic contact-centre data (SQLite). For each of N seeds: 30 weeks of ordinary data with nothing
// planted; the false-alarm replay over its complete weeks (the analysis' own tools, no model, no Toolbox); then known faults planted in a copy of the
// newest quiet week, at several sizes, to see how often each kind is found and how that depends on size.
//   node scripts/rates.mjs [--seeds 8] [--weeks 30] [--sizes 2,3,4,6] [--null poisson|noisy-queue|noisy-team|many-parts] [--variant label]
//                          [--kpis service_level,calls_offered] [--no-faults] [--out file]
//   --null     what the ordinary data is like. poisson: steady noise. noisy-queue / noisy-team: each queue's or team's weekly volume moves by a random
//              factor of its own (sd 8%). many-parts: a further dimension of 600 accounts of very uneven size (Zipf), each with its own weekly volume
//              volatility (sd 35%) and its own weekly wobble in the rate (sd 6 points), so one run compares hundreds of parts, as real data with
//              companies or states does. Nothing is planted in any of
//              them, so every flag is a false alarm.
//              noisy-rate: each team's (or with --noise-by queue, each queue's) weekly rate moves by a random amount of its own, a normal with
//              sd --noise-sd (default 0.02, in points of the rate; 0 is the steady data). scripts/noise-rates.mjs sweeps the levels.
//   --variant  a label for the analysis being measured, so a before and an after sit in one table
//   --pin-parent-z <z>  name the headline's bar in the ontology, which keeps exactly that bar (2 reproduces the analysis as it was before the bar
//              followed the alarm budget), for a before measured with the same code as the after
// Writes JSON and prints markdown tables. The faults come from seeds the analysis was never tuned on; the hand-written eval cases are not used.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const nullKind = flag("null", "poisson");
const variant = flag("variant", "current");
const noFaults = process.argv.includes("--no-faults");
const kpis = flag("kpis", "service_level").split(",");
const pinParentZ = flag("pin-parent-z") === undefined ? undefined : Number(flag("pin-parent-z"));
const noiseSd = flag("noise-sd", "0.02");
const noiseBy = flag("noise-by", "team");
const NULLS = { poisson: [], "noisy-queue": ["--fault", "noisy_volume:0.08:queue"], "noisy-team": ["--fault", "noisy_volume:0.08:team"], "many-parts": [], "noisy-rate": Number(noiseSd) > 0 ? ["--fault", `noisy_rate:${noiseSd}:${noiseBy}`] : [] };
const out = resolve(flag("out", `runs/calibration/rates-${variant}-${nullKind}.json`));
if (!NULLS[nullKind]) throw new Error(`--null is one of ${Object.keys(NULLS).join(", ")}`);
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

function rng(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Give every call an account: 600 accounts of very uneven size, each with a volume of its own that moves from week to week. */
function addAccounts(file, seed) {
  const N = 600;
  const rand = rng(seed * 7919 + 13);
  const normal = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const size = Array.from({ length: N }, (_, j) => 1 / Math.pow(j + 1, 0.7));
  const lines = readFileSync(file, "utf-8").trim().split(/\r?\n/);
  const start = Date.UTC(2026, 0, 5);
  const byWeek = new Map();
  const cumulative = (w) => {
    if (!byWeek.has(w)) {
      let acc = 0;
      byWeek.set(w, size.map((s) => (acc += s * Math.exp(0.35 * normal() - (0.35 * 0.35) / 2))));
    }
    return byWeek.get(w);
  };
  // each account's rate also has a wobble of its own from week to week (sd 6 points): a few of its calls that went one way go the other, so the
  // whole's rate stays put while an account's moves, as a company's rate of timely responses does
  const wobble = new Map();
  const shift = (j, w) => {
    const key = j * 1000 + w;
    if (!wobble.has(key)) wobble.set(key, 0.06 * normal());
    return wobble.get(key);
  };
  const rows = [`${lines[0]},account`];
  for (const l of lines.slice(1)) {
    const ts = l.split(",")[1];
    const w = Math.floor((Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10)) - start) / (7 * 86_400_000));
    const cum = cumulative(w);
    const x = rand() * cum[N - 1];
    let lo = 0;
    let hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    const cols = l.split(",");
    const d = shift(lo, w);
    const p0 = 0.8;
    if (d > 0 && cols[5] === "0" && rand() < d / (1 - p0)) cols[5] = "1";
    else if (d < 0 && cols[5] === "1" && rand() < -d / p0) cols[5] = "0";
    rows.push(`${cols.join(",")},acct_${String(lo + 1).padStart(3, "0")}`);
  }
  writeFileSync(file, rows.join("\n") + "\n");
}

const KINDS = ["segment_shift", "offsetting_pair", "mix_shift", "data_gap"];
const withFaults = !noFaults && nullKind !== "many-parts";
const result = { when: new Date().toISOString(), variant, null: nullKind, ...(nullKind === "noisy-rate" ? { noise_sd: Number(noiseSd), noise_by: noiseBy } : {}), kpis, seeds: [], weeks, sizes: withFaults ? sizes : [] };

for (let s = 1; s <= seeds; s++) {
  const work = mkdtempSync(join(tmpdir(), `rates-${s}-`));
  try {
    const gen = spawnSync(py, [join(repo, "packs", "contact-centre", "data", "generate.py"), "--seed", String(1000 + s), "--weeks", String(weeks), ...NULLS[nullKind], "--out-dir", join(work, "raw")], { encoding: "utf-8" });
    if (gen.status !== 0) throw new Error(gen.stderr);
    if (nullKind === "many-parts") addAccounts(join(work, "raw", "calls.csv"), s);
    const files = readdirSync(join(work, "raw")).filter((f) => f.endsWith(".csv")).map((f) => join(work, "raw", f));
    const ws = join(work, "ws");
    await connectFiles({ workspace: ws, files });
    const ontology = parse(readFileSync(join(repo, "packs", "contact-centre", "ontology.yaml"), "utf-8"));
    const data = parse(readFileSync(join(repo, "packs", "contact-centre", "data.yaml"), "utf-8"));
    delete ontology.metrics.workload;
    delete data.source;
    if (pinParentZ !== undefined) ontology.thresholds = { ...(ontology.thresholds ?? {}), parent_z: pinParentZ };
    if (nullKind === "many-parts") {
      ontology.dimensions = [...ontology.dimensions, "account"];
      data.facts.calls.sql = data.facts.calls.sql.replace("c.queue, c.call_reason,", "c.queue, c.call_reason, c.account,");
      data.facts.calls.concepts = [...data.facts.calls.concepts, "account"];
    }
    const saved = await savePack({ workspace: ws, ontology, data });
    if (!saved.saved) throw new Error(saved.errors.join("; "));
    // reconciliation does not change a false-alarm rate or a detection rate: record the rung the checks need
    updateState(ws, (st) => {
      const c = (kind, start, end) => ({ id: `${kind}-1`, kind, scope: {}, window: { start, end }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" });
      for (const k of kpis) st.kpis[k] = { level: "reconciled", checks: [c("total", "2026-01-05", "2026-01-11"), c("slice", "2026-01-05", "2026-01-11"), c("grain", "2026-01-12", "2026-01-12")], auto: { at: "now", pass: true, results: [] } };
    });
    const pack = loadPack(ws, { requireMeta: true });
    const index = new ToolIndex(pack.meta);
    const tools = new SqliteToolCaller(ws);
    const playbook = loadPlaybook("metric_change", ws);
    const rec = { seed: 1000 + s, kpis: {}, faults: [] };
    for (const kpi of kpis) {
      const cal = await calibrate({
        workspace: ws,
        kpi,
        makeTools: async () => tools,
        maxPeriods: weeks,
        chunkMs: 10 * 60_000,
        deps: {
          baseline: 4,
          key: () => "rates",
          periods: () => completeBuckets(tools, index, kpi, pack.ontology.time.levels[0]),
          runOne: async (b) => ({ result: await runPlaybook({ playbook, ontology: pack.ontology, meta: pack.meta, tools, inputs: { metric: kpi, period: b.bucket, baseline: 4 } }) }),
        },
      });
      const ev = cal.evaluation;
      const calFile = JSON.parse(readFileSync(join(ws, `calibration-${kpi}.json`), "utf-8"));
      rec.kpis[kpi] = { judged: ev.judged, not_judged: ev.not_judged, alarms: ev.alarms, flagged: cal.flagged.map((f) => ({ period: f.period, what: f.what, detail: calFile.outcomes[f.period]?.detail })) };
      process.stderr.write(`seed ${s} ${kpi}: ${ev.alarms} of ${ev.judged} judged weeks raised something; ${ev.not_judged} declined\n`);
    }
    // the first KPI also at the top, as earlier runs wrote it
    Object.assign(rec, rec.kpis[kpis[0]]);
    if (withFaults) {
      for (const sigmas of sizes) {
        const r = await injectFaults({ workspace: ws, kpi: kpis[0], seed: 7000 + s * 10 + sigmas, sigmas, chunkMs: 10 * 60_000 });
        for (const o of r.outcomes) rec.faults.push({ sigmas, kind: o.kind, applicable: o.applicable, pass: o.pass, what: o.what, detail: o.detail, control_quiet: r.control?.quiet });
        process.stderr.write(`  size ${sigmas}: ${r.outcomes.filter((o) => o.applicable && o.pass).length} of ${r.outcomes.filter((o) => o.applicable).length} found (control ${r.control?.quiet ? "quiet" : "NOT quiet"})\n`);
      }
    }
    result.seeds.push(rec);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- the tables ------------------------------------------------------------------------------------------------------------------------
const lines = [];
for (const kpi of kpis) {
  const per = result.seeds.map((r) => ({ seed: r.seed, ...r.kpis[kpi] }));
  const judged = per.reduce((a, r) => a + r.judged, 0);
  const alarms = per.reduce((a, r) => a + r.alarms, 0);
  const declined = per.reduce((a, r) => a + r.not_judged, 0);
  const [lo, hi] = wilson(alarms, judged);
  lines.push(`### False alarms (${variant}), ${kpi}, ${per.length} seeds of ${weeks} weeks with nothing planted, ${nullKind} data`);
  lines.push("");
  lines.push(`| | weeks judged | raised something | rate | 95% interval | declined to judge |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of per) lines.push(`| seed ${r.seed} | ${r.judged} | ${r.alarms} | ${pct(r.alarms / Math.max(1, r.judged))} | | ${r.not_judged} |`);
  lines.push(`| **all** | **${judged}** | **${alarms}** | **${pct(alarms / Math.max(1, judged))}** | ${pct(lo)} to ${pct(hi)} | ${declined} |`);
  lines.push("");
}
if (withFaults) {
  lines.push(`### Planted faults found (${variant}), by kind and size (found of planted; the unchanged week raised nothing in ${result.seeds.flatMap((r) => r.faults).filter((f) => f.control_quiet).length / KINDS.length} of ${result.seeds.length * sizes.length} runs)`);
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
}
result.markdown = lines.join("\n");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(result.markdown);
console.log(`\nrows: ${out}`);
