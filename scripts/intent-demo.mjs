#!/usr/bin/env node
// A scripted conversation through causeline-mcp, on whatever database the pack is prepared for.
//   node scripts/intent-demo.mjs                              SQLite (local)
//   CAUSELINE_TARGET=bigquery node scripts/intent-demo.mjs    BigQuery (needs CAUSELINE_BQ_PROJECT and a gcloud sign-in)
// It plays the part of the model (the patches are what a model should send) and prints what the system says back.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadCases, prepareCase } from "../core/eval/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const pack = resolve(repo, "packs", "contact-centre");
const base = loadCases(pack, ["clean_week"])[0];
const workDir = await prepareCase(pack, { ...base, setup: "--fault understaffed:team_05:wk7" }, mkdtempSync(resolve(tmpdir(), "intent-demo-")), false);

const client = new Client({ name: "intent-demo", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")],
    env: { ...process.env, CAUSELINE_PACK: workDir, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks") },
  }),
);
const tool = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return res.structuredContent;
};
const say = (who, text) => console.log(`\n${who}: ${text}`);

try {
  const conn = await tool("check_connection");
  say("connection", conn.summary);

  say("user", "How is the SLA doing?");
  let r = await tool("set_intent", { message: "How is the SLA doing?", patch: { kpi: "SLA" } });
  say("system asks", r.check.question);

  say("user", "Why did it drop in the week of 16 February?");
  r = await tool("set_intent", { message: "Why did it drop in the week of 16 February?", patch: { task: "deep_rca", period: { kind: "range", start: "2026-02-16", end: "2026-02-22" } } });
  say("system", r.check.playback);
  const first = await tool("run_intent");
  say("answer 1", `${first.result.status}; top finding: ${first.result.findings[0]?.dimension} ${first.result.findings[0]?.value}; cost: ${JSON.stringify(first.result.cost ?? "none (local database)")}`);

  say("user", "Just team 5, by day");
  r = await tool("set_intent", { message: "Just team 5, by day", patch: { filters: { team: "team 5" }, aggregation: "by day" } });
  say("system", r.check.playback ?? r.check.question);
  const second = await tool("run_intent");
  say("answer 2", `${second.result.status}; headline change ${second.result.headline?.change}; scope ${second.result.inputs.scope}; cost: ${JSON.stringify(second.result.cost ?? "none")}`);

  say("user", "And call volume?");
  r = await tool("set_intent", { message: "And call volume?", patch: { kpi: "call volume", filters: { team: null } } });
  say("system", `${r.topic_switch?.tell_the_user} ${r.check.playback}`);

  say("user", "Go back to the first one, last week against the week before");
  await tool("recall", { n: 1 });
  r = await tool("set_intent", { message: "last week against the week before", patch: { task: "compare", period: { kind: "relative", unit: "week" }, comparison: "previous" } });
  say("system", r.check.playback);
  const third = await tool("run_intent");
  say("answer 3", `${third.result.status}; ${JSON.stringify(third.result.comparison?.difference ?? null)}; cost: ${JSON.stringify(third.result.cost ?? "none")}`);

  const history = await tool("recall");
  console.log(`\nanswers so far: ${history.history.map((h) => `${h.n}. ${h.playback}`).join("\n                ")}`);
} finally {
  await client.close();
}
