#!/usr/bin/env node
// One KPI taken up the whole ladder through the real MCP server over stdio, in the order the build guide gives, on synthetic contact-centre data
// with two real incidents planted. A script plays the model and the person; the person knows what really happened, so it answers the
// "was something real going on?" questions truthfully and gives numbers worked out from the raw files, never from the system under test.
//   node scripts/ladder-proof.mjs [--seed 1] [--weeks 30] [--json out.json]
// Needs Python (for the generator) and the Toolbox binary. Nothing is read from a cloud database.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repo = resolve(import.meta.dirname, "..");
const flag = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const seed = flag("seed", "1");
const weeks = Number(flag("weeks", "30"));
const outFile = flag("json");
const py = process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");

// two real incidents, at weeks the person remembers: a team that answered far fewer calls in time
const INCIDENTS = [
  { week: 13, team: "team_08", fault: "understaffed:team_08:wk13" },
  { week: 22, team: "team_05", fault: "understaffed:team_05:wk22" },
];
const label = (w) => `2026-W${String(w).padStart(2, "0")}`;
const REAL_WEEKS = new Set(INCIDENTS.map((i) => label(i.week)));

const work = mkdtempSync(join(tmpdir(), "ladder-proof-"));
const gen = spawnSync(py, [join(repo, "packs", "contact-centre", "data", "generate.py"), "--seed", seed, "--weeks", String(weeks), ...INCIDENTS.flatMap((i) => ["--fault", i.fault]), "--out-dir", join(work, "raw")], { encoding: "utf-8" });
if (gen.status !== 0) throw new Error(`the generator failed: ${gen.stderr}`);
const files = readdirSync(join(work, "raw")).filter((f) => f.endsWith(".csv")).map((f) => join(work, "raw", f));
const ws = join(work, "workspace");

const steps = [];
const failures = [];
const note = (step, ok, detail) => {
  steps.push({ step, ok, detail: String(detail ?? "").slice(0, 400) });
  console.log(`${ok ? "ok  " : "FAIL"} ${step}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`);
  if (!ok) failures.push(step);
};

const client = new Client({ name: "ladder-proof", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")], env: { ...process.env, CAUSELINE_PACK: ws, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), CAUSELINE_NO_BROWSER: "1" } }));
const tool = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args }, { timeout: 15 * 60_000 });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return res.structuredContent;
};
const rung = async () => (await tool("signoff_status", { kpi: "service_level" })).kpis[0].level;

try {
  // --- build and reconcile: numbers from the raw files ------------------------------------------------------------------
  await tool("connect_files", { files });
  await tool("describe_data");
  const ontology = parse(readFileSync(join(repo, "packs", "contact-centre", "ontology.yaml"), "utf-8"));
  const data = parse(readFileSync(join(repo, "packs", "contact-centre", "data.yaml"), "utf-8"));
  delete ontology.metrics.workload;
  delete data.source;
  const saved = await tool("save_pack", { ontology, data, agents: [{ name: "service-level-deep-rca", kpi: "service_level", task: "deep_rca", examples: ["Why did service level drop?"] }] });
  note("the description is saved", saved.saved === true, saved.errors?.join("; "));
  await tool("play_back", { confirm: true });

  const csv = (f) => readFileSync(join(work, "raw", f), "utf-8").trim().split(/\r?\n/).map((l) => l.split(","));
  const calls = csv("calls.csv").slice(1);
  const agents = csv("agents.csv");
  const centreOf = Object.fromEntries(agents.slice(1).map((a) => [a[agents[0].indexOf("agent")], a[agents[0].indexOf("centre")]]));
  const rate = (keep) => {
    const r = calls.filter(keep);
    return r.reduce((a, c) => a + Number(c[5]), 0) / r.length;
  };
  const inside = (w) => (r) => r[1].slice(0, 10) >= w.start && r[1].slice(0, 10) <= w.end;
  await tool("propose_checks", { kpi: "service_level" });
  const stored = () => JSON.parse(readFileSync(join(ws, "build.json"), "utf-8")).kpis.service_level.checks;
  const total = stored().find((c) => c.kind === "total");
  const slice = stored().find((c) => c.kind === "slice" && c.scope.centre);
  const grain = stored().find((c) => c.kind === "grain");
  await tool("confirm_number", { kpi: "service_level", check: total.id, expected: rate(inside(total.window)), source: "the weekly report", tolerance: 0.001 });
  await tool("confirm_number", { kpi: "service_level", check: slice.id, expected: rate((r) => inside(slice.window)(r) && centreOf[r[2]] === slice.scope.centre), source: "the centre report", tolerance: 0.001 });
  const last = await tool("confirm_number", { kpi: "service_level", check: grain.id, expected: rate(inside(grain.window)), source: "the daily export", tolerance: 0.001 });
  note("three numbers from the files are confirmed: reconciled", last.level === "reconciled", `${last.level}: ${last.gap ?? ""}`);

  // --- calibrate: the person answers about each flagged week, truthfully -------------------------------------------------
  let report;
  let calls_n = 0;
  do {
    report = await tool("calibrate", { kpi: "service_level" });
    calls_n++;
  } while (report.stage === "running");
  note("the replay finishes", report.stage === "done", `${calls_n} call(s): ${report.say}`);
  const firstRate = report.evaluation;
  let answered = 0;
  for (const f of report.flagged ?? []) {
    await tool("label_period", { kpi: "service_level", period: f.period, real: REAL_WEEKS.has(f.period), note: REAL_WEEKS.has(f.period) ? "a team was short-staffed" : undefined });
    answered++;
  }
  if (answered > 0) report = await tool("calibrate", { kpi: "service_level" });
  const ev = report.evaluation;
  note("after the answers the KPI is calibrated", (await rung()) === "calibrated" && ev.pass === true, `${firstRate.alarms} flagged of ${firstRate.judged} judged before the answers, ${ev.alarms} of ${ev.judged} after; ${report.say}`);

  // --- incidents: the first may help, the second is kept aside by default ----------------------------------------------------
  const added = [];
  for (const i of INCIDENTS) {
    const proposal = await tool("propose_incident", { kpi: "service_level", text: `Team ${i.team} was short-staffed in week ${i.week}.`, period_words: `week ${i.week}`, finding: { dimension: "team", value: i.team }, question: `Why did service level drop in week ${i.week}?` });
    if (!proposal.ok) {
      note(`incident week ${i.week} can be placed`, false, proposal.problems.join(" "));
      continue;
    }
    added.push(await tool("add_incident", proposal.add_incident));
  }
  note("the first incident helps and the second is kept aside", added.length === 2 && added[0].held_out === false && added[1].held_out === true, JSON.stringify(added.map((a) => a.held_out)));

  // --- planted faults in a copy of the data -------------------------------------------------------------------------------------
  let planted;
  do {
    planted = await tool("inject_faults", { kpi: "service_level" });
  } while (planted.stage === "running");
  note("planted faults are tried", planted.stage === "done", planted.say);
  note("every fault that could be planted is found and the unchanged period stayed quiet", planted.summary?.planted > 0 && planted.summary.found === planted.summary.planted && planted.control?.quiet === true, JSON.stringify({ summary: planted.summary, control: planted.control }));

  // --- the check of the expert ------------------------------------------------------------------------------------------------
  const verified = await tool("verify_expert", { kpi: "service_level" });
  note("both recorded incidents are found", verified.cases.every((c) => c.pass), JSON.stringify(verified.cases.map((c) => [c.id, c.pass, c.held_out])));
  note("the expert is verified", verified.verified === true && (await rung()) === "verified", `${verified.level}: ${(verified.reasons ?? []).join("; ")}`);
  if (outFile) writeFileSync(resolve(outFile), JSON.stringify({ seed, weeks, steps, calibration: { before: firstRate, after: ev }, faults: planted.outcomes, hit_rate: verified.hit_rate, held_out: verified.held_out, level: verified.level }, null, 2));
} finally {
  await client.close();
}
console.log(failures.length ? `\nFAILED at: ${failures.join("; ")}` : "\nTHE LADDER RUN PASSED");
process.exit(failures.length ? 1 : 0);
