#!/usr/bin/env node
// The Explorer's fixed reads on the contact-centre data, on one database, written to a file so two databases can be compared.
//   node scripts/explore-proof.mjs --out runs/explore-sqlite.json                 (SQLite)
//   CAUSELINE_TARGET=bigquery CAUSELINE_BQ_PROJECT=<project> node scripts/explore-proof.mjs --out runs/explore-bq.json
//   node scripts/explore-proof.mjs --compare runs/explore-sqlite.json runs/explore-bq.json
// The same data and the same fixed reads must give the same rows on every database; a difference is a bug in a dialect.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withCostControl } from "../core/connect-bigquery/dist/src/index.js";
import { loadCases, prepareCase } from "../core/eval/dist/src/index.js";
import { Explorer, loadPackForRun, SdkToolCaller, ToolboxProcess, ToolIndex } from "../core/runner/dist/src/index.js";

const args = process.argv.slice(2);
const repo = resolve(import.meta.dirname, "..");

if (args[0] === "--compare") {
  const [a, b] = args.slice(1).map((f) => JSON.parse(readFileSync(f, "utf-8")));
  const diffs = [];
  const near = (x, y) => (typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y)) : x === y);
  a.steps.forEach((s, i) => {
    const t = b.steps[i];
    if (!t) return diffs.push(`step ${i + 1}: missing from the second file`);
    if (Boolean(s.refusal) !== Boolean(t.refusal)) diffs.push(`step ${i + 1} (${s.asked}): refusal in only one`);
    if (s.rows.length !== t.rows.length) diffs.push(`step ${i + 1} (${s.asked}): ${s.rows.length} rows vs ${t.rows.length}`);
    s.rows.forEach((r, k) => {
      for (const c of Object.keys(r)) if (!near(r[c], t.rows[k]?.[c])) diffs.push(`step ${i + 1} row ${k + 1} ${c}: ${r[c]} vs ${t.rows[k]?.[c]}`);
    });
  });
  console.log(diffs.length === 0 ? `identical: ${a.steps.length} steps, ${a.steps.reduce((n, s) => n + s.rows.length, 0)} rows` : diffs.join("\n"));
  if (b.cost) console.log(`second database read ${(b.cost.bytes_scanned / 1e9).toFixed(2)} GB in ${b.cost.queries} queries (about $${b.cost.estimated_usd.toFixed(3)}); per step: ${b.steps.map((s) => `${(s.bytes_scanned ?? 0) / 1e6 | 0} MB`).join(", ")}`);
  process.exit(diffs.length === 0 ? 0 : 1);
}

const out = resolve(args[args.indexOf("--out") + 1] ?? "explore-proof.json");
const pack = join(repo, "packs", "contact-centre");
const c = loadCases(pack, ["understaffed_team"])[0];
const workDir = await prepareCase(pack, c, mkdtempSync(join(tmpdir(), "explore-proof-")), false);
const def = loadPackForRun(workDir);
const server = await ToolboxProcess.start({ cwd: workDir, configDir: "toolbox" });
try {
  const tools = withCostControl(workDir, new SdkToolCaller(server.url));
  const ex = new Explorer({ ontology: def.ontology, index: new ToolIndex(def.meta), tools, question: "proof" });
  const W = { period: "2026-W07" };
  const steps = [
    { op: "rank", kpi: "service_level", by: "team", order: "lowest", top: 5, ...W },
    { op: "breakdown", kpi: "calls_offered", by: "queue", ...W },
    { op: "series", kpi: "service_level", level: "day", start_date: "2026-02-16", end_date: "2026-02-22", filters: { team: "team_05" } },
    { op: "compare", kpi: "service_level", by: "team", nodes: ["team_05", "team_06"], ...W },
    { op: "rank", kpi: "service_level", by: "team", order: "biggest_fall", top: 3, against_period: "2026-W06", ...W },
    { op: "compare", kpi: "calls_offered", period: "2026-W07", against_period: "2026-W06" },
    { op: "breakdown", kpi: "aht", by: "centre", filters: { queue: "billing" }, ...W },
    { op: "profile", kpi: "service_level", cycle: "weekday", ...W },
  ];
  for (const s of steps) await ex.run(s);
  const record = { target: process.env.CAUSELINE_TARGET ?? "sqlite", steps: ex.record.steps.map((s) => ({ asked: s.asked, says: s.says, columns: s.columns, rows: s.rows, notes: s.notes, refusal: s.refusal, queries: s.queries, bytes_scanned: s.bytes_scanned, ms: s.ms })), ...(tools.cost?.() ? { cost: tools.cost() } : {}) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n", "utf-8");
  console.log(`${record.target}: ${record.steps.length} steps, ${record.steps.filter((s) => s.refusal).length} refused -> ${out}`);
  for (const s of record.steps) console.log(`  ${s.refusal ? "REFUSED " : ""}${s.asked}: ${s.rows.length} rows, ${s.ms} ms${s.bytes_scanned !== undefined ? `, ${(s.bytes_scanned / 1e6).toFixed(0)} MB` : ""}`);
} finally {
  await server.stop();
}
