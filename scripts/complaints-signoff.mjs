#!/usr/bin/env node
// Signs off the complaints pack's KPIs against the CFPB's own published counts (a different system from the BigQuery copy), through the
// MCP tools, and records the result. It plays the person who has those reports: the numbers are fetched live from the CFPB's public
// complaint search at run time, never typed in. Needs CAUSELINE_BQ_PROJECT and a Google sign-in; reads about 10 GB (a few cents).
//   node scripts/complaints-signoff.mjs [--folder <dir>] [--verify] [--only-verify]
// With --verify it also runs the pack's eval cases and replays the recorded incident for each expert whose KPI is reconciled and that has one.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";

const repo = resolve(import.meta.dirname, "..");
const pack = join(repo, "packs", "complaints");
const project = process.env.CAUSELINE_BQ_PROJECT;
if (!project) throw new Error("set CAUSELINE_BQ_PROJECT");
const flag = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const folder = resolve(flag("folder", mkdtempSync(join(tmpdir(), "complaints-signoff-"))));
mkdirSync(folder, { recursive: true });

// the CFPB's published counts, live
const base = "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/";
async function published(min, max, filter = "") {
  const j = await (await fetch(`${base}?date_received_min=${min}&date_received_max=${max}&size=0${filter}`)).json();
  const agg = (k) => Object.fromEntries((j.aggregations?.[k]?.[k]?.buckets ?? []).map((b) => [b.key, b.doc_count]));
  return { total: j.hits.total.value, timely: agg("timely").Yes ?? 0, relief: agg("company_response")["Closed with monetary relief"] ?? 0 };
}
const PRODUCT = "Credit reporting, credit repair services, or other personal consumer reports";
const SOURCE = "the CFPB's public complaint search (consumerfinance.gov)";
// windows inside the part of the data that agrees with the CFPB's counts (it ends 2023-02-12)
const WEEK = ["2022-11-07", "2022-11-13"];
const DAY = ["2022-11-09", "2022-11-09"];
const windows = [
  { label: "the whole data, a week", win: WEEK, scope: {}, filter: "" },
  { label: "one day", win: DAY, scope: {}, filter: "" },
  { label: "one product, a week", win: WEEK, scope: { product: PRODUCT }, filter: `&product=${encodeURIComponent(PRODUCT)}` },
  { label: "one state, a week", win: WEEK, scope: { state: "FL" }, filter: "&state=FL" },
];

const client = new Client({ name: "complaints-signoff", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")], env: { ...process.env, CAUSELINE_PACK: folder, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), CAUSELINE_NO_BROWSER: "1" } }));
const tool = async (name, args = {}) => {
  // a check of an expert runs the pack's eval cases (minutes), so the default 60 s limit is not enough
  const res = await client.callTool({ name, arguments: args }, { timeout: 30 * 60_000 });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return res.structuredContent;
};
const say = (t) => console.log(t);
const report = { folder, windows: [], kpis: {} };

try {
  const only = process.argv.includes("--only-verify");
  const value = { complaint_volume: (n) => n.total, timely_response_rate: (n) => n.timely / n.total, monetary_relief_rate: (n) => n.relief / n.total };
  if (!only) {
  const c = await tool("connect_bigquery", { table: "bigquery-public-data.cfpb_complaints.complaint_database", project });
  say(`connect: ${c.summary}`);
  const ontology = parse(readFileSync(join(pack, "ontology.yaml"), "utf-8"));
  const data = parse(readFileSync(join(pack, "data.yaml"), "utf-8"));
  delete data.source;
  delete data.dialect;
  delete data.budget_gb; // the Builder works the budget out again from this table
  const agents = readdirSync(join(pack, "agents")).map((f) => parse(readFileSync(join(pack, "agents", f), "utf-8")));
  const saved = await tool("save_pack", { ontology, data, agents });
  if (!saved.saved) throw new Error(saved.errors.join("; "));
  say(`save_pack: ${saved.tools} tools; budget ${saved.budget_gb} GB; ${saved.warnings.join(" | ")}`);
  await tool("play_back", { confirm: true });

  const numbers = {};
  for (const w of windows) numbers[w.label] = await published(w.win[0], w.win[1], w.filter);
  report.windows = windows.map((w) => ({ ...w, published: numbers[w.label] }));
  for (const w of windows) say(`published, ${w.label} (${w.win.join("..")}): ${JSON.stringify(numbers[w.label])}`);

  // small counts move by a few complaints between a copy and the live site (late revisions), so a share of a few dozen needs room
  const tolerance = { complaint_volume: 0.01, timely_response_rate: 0.01, monetary_relief_rate: 0.1 };
  for (const kpi of Object.keys(value)) {
    report.kpis[kpi] = [];
    for (const w of windows) {
      const p = await tool("propose_checks", { kpi, odd_period: { start: w.win[0], end: w.win[1], scope: w.scope } });
      const check = p.proposals.find((x) => labelMatches(x.label, w));
      if (!check) { say(`  ${kpi}: no check for ${w.label}`); continue; }
      const r = await tool("confirm_number", { kpi, check: check.id, expected: value[kpi](numbers[w.label]), source: SOURCE, tolerance: tolerance[kpi] });
      say(`  ${kpi} / ${w.label}: theirs ${r.expected}, ours ${r.got}, match ${r.match}, confirmed ${r.confirmed}, level ${r.level}`);
      report.kpis[kpi].push({ window: w.label, kind: check.kind, theirs: r.expected, ours: r.got, match: r.match, confirmed: r.confirmed });
    }
    const st = (await tool("signoff_status", { kpi })).kpis[0];
    say(`${kpi}: ${st.level}${st.gap ? ` (${st.gap})` : ""}; automatic checks ${st.auto ? (st.auto.pass ? "pass" : "FAIL") : "not run"}`);
    report.kpis[kpi].level = st.level;
    report.kpis[kpi].auto = st.auto?.results?.map((x) => `${x.ok ? (x.skipped ? "skip" : "ok") : "FAIL"} ${x.id}`);
  }

  }
  if (process.argv.includes("--verify")) {
    if (!only) await tool("add_incident", { kpi: "complaint_volume", start_date: "2017-09-04", end_date: "2017-09-10", finding: { dimension: "company_name", value: "EQUIFAX, INC." }, question: "Why did complaint volume jump in the week of 4 September 2017?", anywhere: true }).catch((e) => say(`add_incident: ${e.message}`));
    for (const kpi of Object.keys(value)) {
      report.kpis[kpi] ??= [];
      const v = await tool("verify_expert", { kpi });
      say(`verify_expert ${kpi}: verified=${v.verified} level=${v.level} ${v.reasons.join("; ")}`);
      report.kpis[kpi].expert = { verified: v.verified, reasons: v.reasons };
    }
  }
  writeFileSync(join(folder, "signoff-report.json"), JSON.stringify(report, null, 2));
  say(`report: ${join(folder, "signoff-report.json")}`);
} finally {
  await client.close();
}

/** Which of the proposals is the one for this window and part of the data. */
function labelMatches(label, w) {
  const part = Object.values(w.scope)[0];
  const day = w.win[0] === w.win[1];
  if (part && !label.toLowerCase().includes(String(part).toLowerCase())) return false;
  return day ? /on 9 November 2022/.test(label) : /7–13 November 2022/.test(label) || /7-13 November 2022/.test(label);
}
