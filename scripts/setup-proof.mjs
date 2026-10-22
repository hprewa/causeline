#!/usr/bin/env node
// Guided setup on real BigQuery, through the real MCP server over stdio: a fresh project, the prep card filled in turns, a cost limit set in dollars,
// discovery from one KPI on the public CFPB dataset (shortlist first, then only the confirmed table), the message to an administrator,
// then a SECOND session in the same Causeline folder that must pick up where the first stopped.
// Needs a Google sign-in for applications and CAUSELINE_BQ_PROJECT (the project queries are billed to).
//   node scripts/setup-proof.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repo = resolve(import.meta.dirname, "..");
const project = process.env.CAUSELINE_BQ_PROJECT;
if (!project) throw new Error("set CAUSELINE_BQ_PROJECT to the project queries are billed to");
const home = mkdtempSync(join(tmpdir(), "setup-proof-"));
const failures = [];
const check = (n, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
  if (!ok) failures.push(n);
};

async function session() {
  const client = new Client({ name: "setup-proof", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")],
      env: { ...process.env, CAUSELINE_HOME: home, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), CAUSELINE_NO_BROWSER: "1", CAUSELINE_PACK: "" },
    }),
  );
  const tool = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { error: res.isError ? res.content?.[0]?.text : undefined, body: res.structuredContent };
  };
  return { client, tool };
}

let a = await session();
try {
  const made = await a.tool("create_project", { name: "Proof" });
  check("a new project is made and opened", !made.error, made.error);
  const card0 = await a.tool("setup_card");
  check("the empty card asks for the KPI first", /which one KPI/.test(card0.body?.next ?? ""), card0.body?.next);
  await a.tool("save_setup_card", { kpi: "complaint volume" });
  const card1 = await a.tool("save_setup_card", { how_calculated: "number of complaints received per week, from the weekly report", numbers: [{ period: "2020-W10", value: 1000, source: "weekly report" }] });
  check("answers are taken a few at a time and the next question moves on", /incidents/.test(card1.body?.next ?? "") || /number they trust/.test(card1.body?.next ?? ""), card1.body?.next);

  const conn = await a.tool("connect_bigquery", { dataset: "bigquery-public-data.cfpb_complaints", project });
  check("the whole public dataset is connected", !conn.error && conn.body?.connected, conn.error ?? conn.body?.summary);
  const names = (conn.body?.tables ?? []).map((t) => t.name);
  console.log(`  connected tables: ${names.join(", ")}`);

  const cap0 = await a.tool("cost_limit");
  check("the standard limit is said in plain words", /standard limit/.test(cap0.body?.say ?? ""), cap0.body?.say);
  const cap1 = await a.tool("cost_limit", { dollars: 1 });
  check("a limit set in dollars is read back in both", /175\.9 GB|176 GB/.test(cap1.body?.say ?? "") && /\$1\.00/.test(cap1.body?.say ?? ""), cap1.body?.say);

  const first = await a.tool("discover_for_kpi", { kpi: "complaint volume" });
  check("the first call reads nothing and shortlists", first.body?.stage === "shortlist" && !first.error, first.error ?? first.body?.say);
  console.log(`  ${first.body?.say}`);
  const pick = first.body?.shortlist?.matches?.[0]?.table;
  check("the shortlist puts the complaints table first, with a reason", /complaint/.test(pick ?? "") && (first.body?.shortlist?.matches?.[0]?.why?.length ?? 0) > 0, pick);

  let second = await a.tool("discover_for_kpi", { kpi: "complaint volume", tables: [pick] });
  if (second.body?.needs_go_ahead) {
    console.log(`  asked first: ${second.body.say}`);
    check("a read over 1 GB asks first and reads nothing", true);
    second = await a.tool("discover_for_kpi", { kpi: "complaint volume", tables: [pick], go_ahead: true });
  } else {
    console.log("  (this table is under 1 GB, so no go-ahead was needed)");
  }
  check("the confirmed table alone is looked at, and a draft comes back in sentences", second.body?.stage === "draft" && second.body.draft.length > 0 && second.body.description.tables.length === 1, second.error ?? second.body?.say);
  for (const s of second.body?.draft ?? []) console.log(`  draft: ${s}`);
  for (const r of second.body?.risks ?? []) console.log(`  risk:  ${r}`);
  check("the draft names the date column", (second.body?.draft ?? []).some((s) => /date_received/.test(s)));
  console.log(`  looking read ${(((second.body?.description?.cost?.bytes) ?? 0) / 1e9).toFixed(2)} GB`);

  const help = await a.tool("access_help", { dataset: "bigquery-public-data.cfpb_complaints" });
  check("the message to an administrator names both roles and the limit chosen", /dataViewer/.test(help.body?.message ?? "") && /jobUser/.test(help.body?.message ?? "") && /up to 176 GB/.test(help.body?.message ?? ""), help.error);
  const conn2 = await a.tool("check_connection");
  check("the connection check passes", conn2.body?.ok === true, conn2.error ?? conn2.body?.summary);
  const st1 = await a.tool("build_status");
  console.log(`  progress before stopping: ${st1.body?.progress}; next: ${st1.body?.next}`);
} finally {
  await a.client.close();
}

// the person comes back later, in a new session of any client, with the same Causeline folder
a = await session();
try {
  const opened = await a.tool("open_project", { name: "Proof" });
  check("a new session opens the project and says how far setup got", !opened.error && /setup steps done/.test(opened.body?.progress ?? ""), opened.error ?? opened.body?.progress);
  console.log(`  resumed: ${opened.body?.progress}; next: ${opened.body?.next}`);
  const card = await a.tool("setup_card");
  check("the card kept the answers", card.body?.items?.[0]?.detail === "complaint volume" && card.body?.trusted_numbers?.[0]?.value === 1000, card.body?.items?.[0]?.detail);
  const cap = await a.tool("cost_limit");
  check("the chosen limit was kept", /176 GB/.test(cap.body?.say ?? "") && !/standard/.test(cap.body?.say ?? ""), cap.body?.say);
} finally {
  await a.client.close();
}
console.log(failures.length === 0 ? "GUIDED SETUP RUN PASSED" : `GUIDED SETUP RUN FAILED: ${failures.join("; ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
