#!/usr/bin/env node
// One table for the noise question (build guide, Phase 0): how often does a quiet week raise something as the parts' rates wobble more, and how
// often is a planted fault still found? Runs scripts/rates.mjs once for each noise level (one after the other: each is heavy) and puts the
// results side by side.
//   node scripts/noise-rates.mjs [--levels 0,0.01,0.02,0.03] [--by team] [--seeds 6] [--weeks 30] [--sizes 4,6] [--no-faults] [--out file]
// A level is the standard deviation of each team's (or queue's) weekly move in the rate, in points of the rate: 0.02 is two points.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const flag = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const levels = flag("levels", "0,0.01,0.02,0.03").split(",");
const by = flag("by", "team");
const seeds = flag("seeds", "6");
const weeks = flag("weeks", "30");
const sizes = flag("sizes", "4,6");
const noFaults = process.argv.includes("--no-faults");
const out = resolve(flag("out", "docs/evidence/data/noise-rates.json"));

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const cell = (k, n) => (n === 0 ? "none planted" : `${k} of ${n} (${pct(k / n)}; ${wilson(k, n).map(pct).join(" to ")})`);

const rows = [];
for (const level of levels) {
  const file = join(repo, "runs", "calibration", `noise-${by}-${level}.json`);
  const args = [join(repo, "scripts", "rates.mjs"), "--null", "noisy-rate", "--noise-sd", level, "--noise-by", by, "--seeds", seeds, "--weeks", weeks, "--sizes", sizes, "--variant", `noise-${level}`, "--out", file, ...(noFaults ? ["--no-faults"] : [])];
  process.stderr.write(`noise ${level} by ${by}\n`);
  const r = spawnSync(process.execPath, args, { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`rates.mjs failed at noise ${level}`);
  const j = JSON.parse(readFileSync(file, "utf-8"));
  const judged = j.seeds.reduce((a, s) => a + s.judged, 0);
  const alarms = j.seeds.reduce((a, s) => a + s.alarms, 0);
  const faults = j.seeds.flatMap((s) => s.faults).filter((f) => f.applicable);
  const found = Object.fromEntries(j.sizes.map((sg) => [sg, { planted: faults.filter((f) => f.sigmas === sg).length, found: faults.filter((f) => f.sigmas === sg && f.pass).length }]));
  rows.push({ noise_sd: Number(level), by, seeds: j.seeds.length, judged, alarms, rate: judged ? alarms / judged : 0, interval: wilson(alarms, judged), found, flagged: j.seeds.flatMap((s) => s.flagged.map((f) => ({ seed: s.seed, ...f }))) });
}

const sizeList = noFaults ? [] : sizes.split(",");
const lines = [
  `| noise (sd of each ${by}'s weekly move) | quiet weeks judged | raised something | false-alarm rate | 95% interval |${sizeList.map((s) => ` planted faults found at ${s} standard errors |`).join("")}`,
  `|---|---|---|---|---|${sizeList.map(() => "---|").join("")}`,
  ...rows.map((r) => `| ${r.noise_sd} | ${r.judged} | ${r.alarms} | ${pct(r.rate)} | ${r.interval.map(pct).join(" to ")} |${sizeList.map((s) => ` ${cell(r.found[s]?.found ?? 0, r.found[s]?.planted ?? 0)} |`).join("")}`),
];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), kpi: "service_level", by, weeks: Number(weeks), rows, markdown: lines.join("\n") }, null, 2));
console.log(lines.join("\n"));
