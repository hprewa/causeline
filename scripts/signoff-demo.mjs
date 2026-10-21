#!/usr/bin/env node
// The sign-off ladder through the real MCP server and its local screen, on the contact-centre example (SQLite, Toolbox).
//   node scripts/signoff-demo.mjs [--shots <folder>]     scripted run, optionally with pictures of the page
//   node scripts/signoff-demo.mjs --hands-on             opens the page in your browser, with numbers to type, and waits (Ctrl+C to stop)
// It plays the part of the model (chat tools) and of the person at the screen (the page's own HTTP calls), with the
// "numbers from the user's reports" worked out here from the raw CSV files and not by the system under test.
// With --shots it also takes pictures of the page (needs Microsoft Edge or Chrome on this computer).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";
import { connectFiles, savePack } from "../core/builder/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const handsOn = process.argv.includes("--hands-on");
const shots = process.argv.includes("--shots") ? resolve(process.argv[process.argv.indexOf("--shots") + 1]) : null;
const dir = mkdtempSync(join(tmpdir(), "signoff-demo-"));
const py = process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");
const gen = spawnSync(py, [join(repo, "packs", "contact-centre", "data", "generate.py"), "--fault", "understaffed:team_05:wk7", "--out-dir", join(dir, "raw")], { encoding: "utf-8" });
if (gen.status !== 0) throw new Error(gen.stderr);

// a workspace built from the raw files, as the Builder would, with the shipped description as the draft
const ws = join(dir, "workspace");
const files = readdirSync(join(dir, "raw")).filter((f) => f.endsWith(".csv")).map((f) => join(dir, "raw", f));
const connected = await connectFiles({ workspace: ws, files });
const pack = join(repo, "packs", "contact-centre");
const ontology = parse(readFileSync(join(pack, "ontology.yaml"), "utf-8"));
const data = parse(readFileSync(join(pack, "data.yaml"), "utf-8"));
data.source = connected.source;
delete ontology.metrics.workload;
const saved = await savePack({ workspace: ws, ontology, data, agents: [{ name: "service-level-deep-rca", kpi: "service_level", task: "deep_rca", examples: ["Why did service level drop?"] }] });
if (!saved.saved) throw new Error(saved.errors.join("; "));

// the person's reports: worked out from the raw files
const csv = (f) => readFileSync(join(dir, "raw", f), "utf-8").trim().split(/\r?\n/).map((l) => l.split(","));
const calls = csv("calls.csv").slice(1); // call_id,ts,agent,queue,call_reason,answered_within_20s,...
const agents = csv("agents.csv");
const centreOf = Object.fromEntries(agents.slice(1).map((a) => [a[agents[0].indexOf("agent")], a[agents[0].indexOf("centre")]]));
const rate = (keep) => { const r = calls.filter(keep); return r.reduce((a, c) => a + Number(c[5]), 0) / r.length; };
const within = (w) => (r) => r[1].slice(0, 10) >= w.start && r[1].slice(0, 10) <= w.end;

const client = new Client({ name: "signoff-demo", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")],
    env: { ...process.env, CAUSELINE_PACK: ws, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), ...(handsOn ? {} : { CAUSELINE_NO_BROWSER: "1" }) },
  }),
);
const tool = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return res.structuredContent;
};
const say = (who, text) => console.log(`\n${who}: ${text}`);

let url;
const screen = async (path, body) => {
  const root = new URL(url).pathname;
  const res = await fetch(`${new URL(url).origin}${root}api/${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(`screen ${path}: ${json.error}`);
  return json;
};
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
function shoot(name, theme) {
  if (!shots || !edge) return;
  mkdirSync(shots, { recursive: true });
  const out = join(shots, `${name}.png`);
  spawnSync(edge, ["--headless=new", "--disable-gpu", `--screenshot=${out}`, "--window-size=900,1500", "--virtual-time-budget=4000", ...(theme === "dark" ? ["--force-dark-mode", "--enable-features=WebContentsForceDark"] : []), url], { stdio: "ignore", timeout: 60000 });
  console.log(`  [picture: ${out}]`);
}

if (handsOn) {
  try {
    await tool("propose_checks", { kpi: "service_level" });
    const stored = JSON.parse(readFileSync(join(ws, "build.json"), "utf-8")).kpis.service_level.checks;
    const opened = await tool("open_signoff", { kpi: "service_level" });
    console.log(`
The sign-off page: ${opened.url}
(${opened.opened ? "your browser was asked to open it" : "open that address in your browser"}; it stays up while this script runs, Ctrl+C to stop)
`);
    console.log("Numbers to type (worked out from the raw data files, standing in for your own reports). Try a wrong one first to see the mismatch:");
    for (const c of stored) {
      const keep = (r) => within(c.window)(r) && (!c.scope.centre || centreOf[r[2]] === c.scope.centre) && (!c.scope.queue || r[3] === c.scope.queue);
      console.log(`  ${c.label}: ${(rate(keep) * 100).toFixed(2)}%`);
    }
    await new Promise(() => {});
  } finally {
    await client.close();
  }
}
try {
  say("status", JSON.stringify((await tool("signoff_status", { kpi: "service_level" })).kpis[0].level));
  const p = await tool("propose_checks", { kpi: "service_level" });
  say("system proposes (no numbers of ours with the questions)", "\n  " + p.proposals.map((x) => `${x.id}: ${x.label}`).join("\n  "));
  const total = p.proposals.find((x) => x.kind === "total");
  const slice = p.proposals.find((x) => x.kind === "slice" && /entre/.test(x.label));
  const grain = p.proposals.find((x) => x.kind === "grain");
  const window = (id) => JSON.parse(readFileSync(join(ws, "build.json"), "utf-8")).kpis.service_level.checks.find((c) => c.id === id);

  const wrong = await tool("confirm_number", { kpi: "service_level", check: total.id, expected: 70, source: "the weekly report" });
  say("user (chat) gives 70% for the whole business", `confirmed=${wrong.confirmed}; ours ${(wrong.got * 100).toFixed(2)}%; ${wrong.hints[0]}`);
  const w = window(total.id).window;
  const right = await tool("confirm_number", { kpi: "service_level", check: total.id, expected: rate(within(w)), source: "the weekly report (raw calls file)", tolerance: 0.001 });
  say("user (chat) corrects it", `confirmed=${right.confirmed}; level=${right.level}; ${right.gap}`);

  const opened = await tool("open_signoff", { kpi: "service_level" });
  url = opened.url;
  say("open_signoff", `${opened.url.replace(/\/[^/]{20,}\//, "/<secret>/")} (browser started: ${opened.opened})`);
  const s1 = (await screen("status")).kpis.find((k) => k.kpi === "service_level");
  say("the screen shows", `${s1.level}; ${s1.checks.map((c) => `${c.id}:${c.state}`).join(", ")}`);
  shoot("1-one-number-confirmed");

  // at the screen: a number that does not match the slice, then the right one
  const cw = window(slice.id);
  const centre = Object.values(cw.scope)[0];
  const bad = await screen("number", { kpi: "service_level", check: slice.id, expected: rate((r) => within(cw.window)(r) && centreOf[r[2]] === centre) * 100 - 6, source: "the centre report" });
  say("person at the screen types a slightly wrong number for " + centre, `match=${bad.match}; ours ${(bad.got * 100).toFixed(2)}%; hints: ${bad.hints.length}`);
  shoot("2-a-number-that-does-not-match");
  await screen("number", { kpi: "service_level", check: slice.id, expected: rate((r) => within(cw.window)(r) && centreOf[r[2]] === centre) * 100, source: "the centre report" });
  const d = await screen("decide", { kpi: "service_level", check: slice.id, decision: "confirm" });
  say("person at the screen enters the right one and presses Confirm", `level=${d.level}`);

  const gw = window(grain.id).window;
  const third = await tool("confirm_number", { kpi: "service_level", check: grain.id, expected: rate(within(gw)), source: "the daily export", tolerance: 0.001 });
  say("user (chat) gives a third number, for one day", `confirmed=${third.confirmed}; level=${third.level}`);

  const viaChat = (await tool("signoff_status", { kpi: "service_level" })).kpis[0];
  say("the chat tool sees the same", `${viaChat.level}; ${viaChat.checks.map((c) => `${c.id}:${c.state}${c.source ? ` (${c.source})` : ""}`).join(", ")}`);
  shoot("3-reconciled");
  shoot("4-reconciled-dark", "dark");

  const ver = await tool("add_incident", { kpi: "service_level", period: "2026-W07", finding: { dimension: "team", value: "team_05" }, question: "Why did service level drop in week 7?" });
  const v = await tool("verify_expert", { kpi: "service_level" });
  say("verify_expert (needs a reconciled KPI and the incident)", `verified=${v.verified} level=${v.level} ${v.reasons.join("; ")}`);
  void ver;
} finally {
  await client.close();
}
