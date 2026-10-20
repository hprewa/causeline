#!/usr/bin/env node
// The Builder on BigQuery, through the real MCP server (stdio) and Toolbox. Needs a Google Cloud sign-in for applications
// (`gcloud auth application-default login`) and CAUSELINE_BQ_PROJECT set to the project queries are billed to.
//   node scripts/bigquery-build-demo.mjs --example    the contact-centre data, loaded to a small dataset of yours, built to a verified KPI
//   node scripts/bigquery-build-demo.mjs --public     the public CFPB complaints table: connect, look, try a fact, save a small pack (reads about 1-2 GB)
// Every step prints what it read. The "numbers from the user's reports" in --example come from the raw files, not from the system under test.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";
import { loadDataset } from "../core/connect-bigquery/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const project = process.env.CAUSELINE_BQ_PROJECT;
if (!project) throw new Error("set CAUSELINE_BQ_PROJECT to the project queries are billed to");
const mode = process.argv.includes("--public") ? "public" : "example";
const dir = mkdtempSync(join(tmpdir(), `bq-build-${mode}-`));
const ws = join(dir, mode === "public" ? "complaints" : "contact-centre");

const client = new Client({ name: "bq-build-demo", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")],
    env: { ...process.env, CAUSELINE_PACK: ws, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), CAUSELINE_NO_BROWSER: "1" },
  }),
);
const tool = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return res.structuredContent;
};
const say = (who, text) => console.log(`\n${who}: ${text}`);
const gb = (b) => `${(b / 1e9).toFixed(2)} GB`;
const read = (r) => (r.cost ? `read ${gb(r.cost.bytes)} in ${r.cost.queries} queries (about $${r.cost.estimated_usd.toFixed(4)})` : r.bytes !== undefined ? `read ${gb(r.bytes)}` : "");
let total = 0;
const count = (r) => { if (r?.cost?.bytes) total += r.cost.bytes; if (r?.bytes) total += r.bytes; return r; };

try {
  if (mode === "public") {
    const c = await tool("connect_bigquery", { table: "bigquery-public-data.cfpb_complaints.complaint_database", project });
    say("connect_bigquery", `${c.summary}\n  tables: ${c.tables.map((t) => `${t.name} (${t.rows} rows, ${t.gb} GB, ${t.columns.length} columns)`).join("; ")}\n  notes: ${c.notes.join(" | ") || "none"}`);
    const d = count(await tool("describe_data"));
    say("describe_data", read(d));
    for (const n of d.notes ?? []) console.log(`  note: ${n}`);
    for (const a of d.ask ?? []) console.log(`  ask: ${a}`);
    for (const col of d.tables[0].columns) console.log(`  ${col.name.padEnd(30)} ${col.type.padEnd(9)} distinct~${String(col.distinct).padEnd(8)} nulls ${String(col.nulls).padEnd(8)} ${col.roles.join(",")}`);
    console.log(`  hierarchies: ${JSON.stringify(d.hierarchies)}\n  time: ${JSON.stringify(d.time)}`);

    const sql = "SELECT TIMESTAMP(date_received) AS ts, product, CONCAT(product, ' / ', subproduct) AS subproduct, issue, CONCAT(issue, ' / ', subissue) AS subissue, company_name, state, submitted_via, timely_response, company_response_to_consumer FROM `bigquery-public-data.cfpb_complaints.complaint_database`";
    const t = count(await tool("test_fact", { sql: sql.replace("TIMESTAMP(date_received)", "date_received"), time: "ts", concepts: ["product", "company_name"] }));
    say("test_fact with the DATE left as it is", `${t.ok ? "ran" : "refused"}; warnings: ${t.warnings.join(" | ")}; ${read(t)}`);
    const t2 = count(await tool("test_fact", { sql, time: "ts", concepts: ["product", "subproduct", "issue", "subissue", "company_name", "state", "submitted_via"] }));
    say("test_fact with TIMESTAMP(date_received)", `${t2.rows} rows; warnings: ${t2.warnings.join(" | ") || "none"}; ${read(t2)}`);

    const ontology = {
      time: { levels: ["week", "day"], seasonality: "none" },
      hierarchies: { product: ["product", "subproduct"], issue: ["issue", "subissue"] },
      dimensions: ["state", "company_name", "submitted_via"],
      metrics: {
        timely_response_rate: { type: "ratio", direction: "higher_is_better", min_volume: 30, description: "Share of complaints the company answered on time.", synonyms: ["on-time response rate"] },
        complaint_volume: { type: "sum", direction: "lower_is_better", min_volume: 30, description: "Complaints received.", synonyms: ["complaints", "volume"] },
      },
    };
    const data = {
      as_of: "data_end",
      facts: { complaints: { sql, time: "ts", concepts: ["product", "subproduct", "issue", "subissue", "company_name", "state", "submitted_via"] } },
      metrics: { timely_response_rate: { fact: "complaints", numerator: "CAST(timely_response AS INT64)" }, complaint_volume: { fact: "complaints", value: "1" } },
    };
    const s = count(await tool("save_pack", { ontology, data }));
    say("save_pack", `saved=${s.saved}; tools=${s.tools}; budget set to ${s.budget_gb} GB; ${read(s)}\n  errors: ${s.errors.join(" | ") || "none"}\n  warnings: ${s.warnings.join(" | ") || "none"}`);
    if (s.saved) {
      const p = await tool("propose_checks", { kpi: "complaint_volume" });
      say("propose_checks (runs the generated tools through Toolbox, metered)", p.proposals.map((x) => x.label).join(" | "));
    }
  } else {
    // the contact-centre example, from raw files to a dataset of the user's own
    const py = process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const pack = join(repo, "packs", "contact-centre");
    const gen = spawnSync(py, [join(pack, "data", "generate.py"), "--fault", "understaffed:team_05:wk7", "--out-dir", join(dir, "raw")], { encoding: "utf-8" });
    if (gen.status !== 0) throw new Error(gen.stderr);
    const spec = JSON.parse(readFileSync(join(pack, "data", "bigquery.json"), "utf-8"));
    const dataset = process.env.CAUSELINE_BQ_DEMO_DATASET || "causeline_build_demo";
    await loadDataset({ project }, dataset, Object.fromEntries(Object.entries(spec.tables).map(([n, t]) => [n, { file: join(dir, "raw", t.file), schema: t.schema }])), { setup: "build-demo", reuse: false });
    say("setup", `loaded the example's tables into ${project}.${dataset} (the user's own data, for the demo)`);

    const c = await tool("connect_bigquery", { dataset, project });
    say("connect_bigquery", `${c.summary} tables: ${c.tables.map((t) => `${t.name.split(".").pop()} (${t.rows} rows)`).join(", ")}`);
    const d = count(await tool("describe_data"));
    say("describe_data", `${read(d)}; hierarchies: ${JSON.stringify(d.hierarchies)}; joins: ${d.joins.map((j) => `${j.from.split(".").slice(-2).join(".")} -> ${j.to.split(".").slice(-2).join(".")} (${j.shape})`).join(", ")}`);
    for (const n of d.notes ?? []) console.log(`  note: ${n}`);

    // the draft an agent would make, here taken from the shipped BigQuery definition with the user's dataset filled in
    const ontology = parse(readFileSync(join(pack, "ontology.yaml"), "utf-8"));
    const data = parse(readFileSync(join(pack, "data.bigquery.yaml"), "utf-8").replaceAll("__DATASET__", `${project}.${dataset}`));
    delete ontology.metrics.workload;
    data.facts.calls.one_row_per = { table: `${project}.${dataset}.calls`, column: "call_id" };
    const s = count(await tool("save_pack", { ontology, data, agents: [{ name: "service-level-deep-rca", kpi: "service_level", task: "deep_rca", examples: ["Why did service level drop?"] }] }));
    say("save_pack", `saved=${s.saved}; tools=${s.tools}; budget ${s.budget_gb ?? "default"} GB; ${read(s)}; errors: ${s.errors.join(" | ") || "none"}; warnings: ${s.warnings.join(" | ") || "none"}`);
    if (!s.saved) throw new Error("not saved");
    await tool("play_back", { confirm: true });

    const csv = (f) => readFileSync(join(dir, "raw", f), "utf-8").trim().split(/\r?\n/).map((l) => l.split(","));
    const calls = csv("calls.csv").slice(1);
    const agents = csv("agents.csv");
    const centreOf = Object.fromEntries(agents.slice(1).map((a) => [a[agents[0].indexOf("agent")], a[agents[0].indexOf("centre")]]));
    const rate = (keep) => { const r = calls.filter(keep); return r.reduce((a, c) => a + Number(c[5]), 0) / r.length; };
    const within = (w) => (r) => r[1].slice(0, 10) >= w.start && r[1].slice(0, 10) <= w.end;
    const checks = () => JSON.parse(readFileSync(join(ws, "build.json"), "utf-8")).kpis.service_level.checks;

    const p = await tool("propose_checks", { kpi: "service_level" });
    say("propose_checks", p.proposals.map((x) => `${x.id}: ${x.label}`).join(" | "));
    const total = checks().find((c) => c.kind === "total");
    const r1 = await tool("confirm_number", { kpi: "service_level", check: total.id, expected: rate(within(total.window)), source: "the weekly report (from the raw calls file)", tolerance: 0.001 });
    say("confirm_number total", `confirmed=${r1.confirmed}; level=${r1.level}`);
    const slice = checks().find((c) => c.kind === "slice" && c.scope.centre);
    const centre = slice.scope.centre;
    const r2 = await tool("confirm_number", { kpi: "service_level", check: slice.id, expected: rate((r) => within(slice.window)(r) && centreOf[r[2]] === centre), source: "the centre report", tolerance: 0.001 });
    say(`confirm_number ${centre}`, `confirmed=${r2.confirmed}; level=${r2.level}; ${r2.gap || "nothing left"}`);
    const st = (await tool("signoff_status", { kpi: "service_level" })).kpis[0];
    say("automatic checks on BigQuery", st.auto.results.map((r) => `${r.ok ? (r.skipped ? "skip" : "ok") : "FAIL"} ${r.id}`).join("; "));
    await tool("add_incident", { kpi: "service_level", period: "2026-W07", finding: { dimension: "team", value: "team_05" }, question: "Why did service level drop in week 7?" });
    const v = await tool("verify_expert", { kpi: "service_level" });
    say("verify_expert", `verified=${v.verified} ${v.reasons.join("; ")}`);
  }
  say("total read by the Builder's own steps (not counting Toolbox runs of the generated tools)", `${gb(total)} (about $${((total / 2 ** 40) * 6.25).toFixed(4)} at list price)`);
} finally {
  await client.close();
}
