#!/usr/bin/env node
// The false-alarm check and the incident replay on REAL data: the CFPB complaints table in BigQuery, through the real MCP server over stdio.
//   Phase 1: node scripts/complaints-calibrate.mjs --folder <dir>
//     signs the KPIs off against the CFPB's published counts (scripts/complaints-signoff.mjs) if the folder has not been, records the three real
//     incidents the pack knows, replays 20 periods spread evenly through the history for complaint_volume and timely_response_rate, and prints
//     every week that raised something, with what the analysis said, for the person to say real or not. Stops there without a labels file.
//   Phase 2: node scripts/complaints-calibrate.mjs --folder <dir> --labels labels.json
//     applies the person's answers ({"complaint_volume": {"2019-W10": true, ...}, ...}; true = something real happened that week), finishes the
//     check without any new replay, replays the recorded incidents, and writes the numbers.
// Needs CAUSELINE_BQ_PROJECT and a Google sign-in. Reads about 600 GB in phase 1 (about $4 at list price); it stops before that if the estimate passes --max-gb.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repo = resolve(import.meta.dirname, "..");
const flag = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const project = process.env.CAUSELINE_BQ_PROJECT;
if (!project) throw new Error("set CAUSELINE_BQ_PROJECT to the project queries are billed to");
const folder = resolve(flag("folder", mkdtempSync(join(tmpdir(), "complaints-calibrate-"))));
mkdirSync(folder, { recursive: true });
const labelsFile = flag("labels");
const spread = Number(flag("spread", "20"));
const maxGb = Number(flag("max-gb", "700"));
const KPIS = ["complaint_volume", "timely_response_rate"];
const usd = (bytes) => (bytes / 1e12) * 6.25;

if (!existsSync(join(folder, "build.json"))) {
  console.log("signing the KPIs off against the CFPB's published counts first...");
  const r = spawnSync(process.execPath, [join(repo, "scripts", "complaints-signoff.mjs"), "--folder", folder], { stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error("the sign-off did not finish");
}

const client = new Client({ name: "complaints-calibrate", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")], env: { ...process.env, CAUSELINE_PACK: folder, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), CAUSELINE_NO_BROWSER: "1", CAUSELINE_BQ_PROJECT: project } }));
const tool = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args }, { timeout: 30 * 60_000 });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return res.structuredContent;
};
const state = () => JSON.parse(readFileSync(join(folder, "build.json"), "utf-8"));
const report = { folder, project, spread, when: new Date().toISOString(), kpis: {} };
const out = (name) => join(folder, name);

try {
  for (const kpi of KPIS) {
    const lvl = state().kpis[kpi]?.level;
    if (lvl !== "reconciled" && lvl !== "calibrated" && lvl !== "verified") throw new Error(`${kpi} is ${lvl}, not reconciled: the sign-off did not finish`);
  }
  // the real incidents the pack knows, recorded as the person would (once)
  const have = new Set(state().incidents.map((i) => `${i.kpi}|${i.text}`));
  const incidents = [
    { kpi: "complaint_volume", start_date: "2016-09-12", end_date: "2016-09-18", finding: { dimension: "company_name", value: "WELLS FARGO & COMPANY" }, question: "Why did complaint volume rise in the week of 12 September 2016?", anywhere: true },
    { kpi: "complaint_volume", start_date: "2017-09-04", end_date: "2017-09-10", finding: { dimension: "company_name", value: "EQUIFAX, INC." }, question: "Why did complaint volume jump in the week of 4 September 2017?", anywhere: true },
    { kpi: "timely_response_rate", start_date: "2017-09-04", end_date: "2017-09-10", finding: { dimension: "company_name", value: "EQUIFAX, INC." }, question: "The timely response rate went up in the week of 4 September 2017. Did companies get better at responding?", anywhere: true },
  ];
  for (const i of incidents) if (!have.has(`${i.kpi}|${i.question}`)) await tool("add_incident", i);
  report.incidents = state().incidents;

  for (const kpi of KPIS) {
    // phase 1: the replay, spread through the history; the cost is shown before anything is read
    let r = await tool("calibrate", { kpi, spread_periods: spread });
    if (r.needs_go_ahead) {
      const gb = r.estimate.total_bytes / 1e9;
      console.log(`${kpi}: ${r.say}`);
      if (gb > maxGb) throw new Error(`${kpi}: the estimate (${gb.toFixed(0)} GB) is over --max-gb ${maxGb}; stopping before reading anything`);
      r = await tool("calibrate", { kpi, spread_periods: spread, go_ahead: true });
    }
    let n = 1;
    while (r.stage === "running") {
      console.log(`  ${kpi}: ${r.say}`);
      r = await tool("calibrate", { kpi, spread_periods: spread, go_ahead: true });
      n++;
    }
    console.log(`${kpi} (${n} call(s)): ${r.say}`);
    const file = JSON.parse(readFileSync(join(folder, `calibration-${kpi}.json`), "utf-8"));
    const bytes = Object.values(file.outcomes).reduce((a, o) => a + (o.bytes ?? 0), 0);
    const ev = r.evaluation;
    const before = { judged: ev.judged, alarms: ev.alarms, not_judged: ev.not_judged, real_events: ev.real_events };
    report.kpis[kpi] = { selection: file.selection, replayed: Object.keys(file.outcomes).length, bytes, usd: usd(bytes), unlabelled: before, declined: r.not_judged, flagged: r.flagged };
  }
  writeFileSync(out("calibration-phase1.json"), JSON.stringify(report, null, 2));
  const spent = Object.values(report.kpis).reduce((a, k) => a + k.usd, 0);
  console.log(`\nread about ${(Object.values(report.kpis).reduce((a, k) => a + k.bytes, 0) / 1e9).toFixed(0)} GB for the replays (about $${spent.toFixed(2)} at list price)`);

  if (!labelsFile) {
    console.log("\nWEEKS THAT RAISED SOMETHING (say for each whether something real happened that week):");
    for (const kpi of KPIS) {
      console.log(`\n${kpi}: ${report.kpis[kpi].unlabelled.alarms} of ${report.kpis[kpi].unlabelled.judged} judged weeks (${report.kpis[kpi].selection})`);
      for (const f of report.kpis[kpi].flagged) console.log(`  ${f.period}  ${f.words}: ${f.what.join("; ")}`);
    }
    console.log(`\nwrite the answers to a labels file and run again with --labels <file> --folder ${folder}`);
  } else {
    // phase 2: the person's answers, then the incidents
    const labels = JSON.parse(readFileSync(resolve(labelsFile), "utf-8"));
    for (const kpi of KPIS) {
      for (const [period, real] of Object.entries(labels[kpi] ?? {})) await tool("label_period", { kpi, period, real: !!real });
      const r = await tool("calibrate", { kpi, spread_periods: spread, go_ahead: true });
      report.kpis[kpi].labelled = { judged: r.evaluation.judged, alarms: r.evaluation.alarms, real_events: r.evaluation.real_events, rate: r.evaluation.rate, upper: r.evaluation.upper, pass: r.evaluation.pass };
      report.kpis[kpi].level = r.level;
      report.kpis[kpi].say = r.say;
      console.log(`${kpi}: ${r.say}`);
      const v = await tool("verify_expert", { kpi });
      report.kpis[kpi].incidents = { found: v.cases.map((c) => ({ id: c.id, pass: c.pass, held_out: c.held_out })), hit_rate: v.hit_rate, verified: v.verified, reasons: v.reasons, level: v.level };
      console.log(`  incidents: ${JSON.stringify(v.cases.map((c) => [c.id, c.pass]))} hit rate ${v.hit_rate}; level ${v.level}`);
    }
    report.labels = labels;
    writeFileSync(out("calibration-final.json"), JSON.stringify(report, null, 2));
    console.log(`\nfinal numbers: ${out("calibration-final.json")}`);
  }
} finally {
  await client.close();
}
