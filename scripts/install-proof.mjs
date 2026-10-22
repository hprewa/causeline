#!/usr/bin/env node
// A clean-machine run of the install path that can be done on this computer: the bundled server, copied somewhere with nothing of the repo
// around it, a fresh Causeline home, and no Toolbox on PATH, in the repo or in the environment. The first question must make the server fetch
// the data connection software itself (the real 294 MB file on Windows), check it against its pinned fingerprint, and then answer.
//   npm run bundle:plugin && node scripts/install-proof.mjs
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadCases, prepareCase } from "../core/eval/dist/src/index.js";
import { BUILDS, installDir, platformKey, sha256Of } from "../core/runner/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const bundled = join(repo, "clients", "claude-code");
if (!existsSync(join(bundled, "server", "causeline-mcp.mjs"))) throw new Error("run `npm run bundle:plugin` first");

const work = mkdtempSync(join(tmpdir(), "install-proof-"));
const installed = join(work, "plugin", "causeline");
cpSync(bundled, installed, { recursive: true });
const home = join(work, "home");
const pack = resolve(repo, "packs", "contact-centre");
const c = loadCases(pack, ["understaffed_team"])[0];
const packDir = await prepareCase(pack, c, join(work, "pack"), false);

// a PATH with Node and nothing else that could hold Toolbox
const node = process.execPath;
const clean = [resolve(node, ".."), process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "/usr/bin"].filter(existsSync).join(delimiter);
const found = spawnSync(process.platform === "win32" ? "where" : "which", ["toolbox"], { env: { ...process.env, PATH: clean }, cwd: work, encoding: "utf-8" });
console.log(`toolbox on the clean PATH: ${found.status === 0 ? found.stdout.trim() : "none"}`);
if (found.status === 0) throw new Error("Toolbox is on the clean PATH; the run would prove nothing");

const env = { PATH: clean, SystemRoot: process.env.SystemRoot ?? "", HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "", TEMP: process.env.TEMP ?? "", CAUSELINE_HOME: home, CAUSELINE_PACK: packDir, CAUSELINE_PLAYBOOKS: join(installed, "playbooks"), CAUSELINE_TOOLBOX: "", CAUSELINE_TOOLBOX_URL: "" };
const client = new Client({ name: "install-proof", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: node, args: [join(installed, "server", "causeline-mcp.mjs")], env, cwd: work }));
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { error: res.isError ? res.content?.[0]?.text : undefined, body: res.structuredContent };
};
try {
  const t0 = Date.now();
  const first = await call("list_playbooks");
  console.log(`first question: ${first.error ? `told: "${first.error.slice(0, 160)}"` : "answered at once (Toolbox was found)"}`);
  const asked = await call("run_playbook", { name: "metric_change", inputs: { metric: "service_level", period: "2026-W07" } });
  console.log(`a question while it downloads: ${asked.error ? `told: "${asked.error.slice(0, 140)}"` : "answered"} (${((Date.now() - t0) / 1000).toFixed(1)} s after start)`);
  let last = "";
  for (let i = 0; i < 240; i++) {
    const s = await call("check_setup");
    const line = s.body?.checks?.find((x) => x.id === "data_connection")?.say ?? "";
    if (line !== last) console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s: ${line}`);
    last = line;
    if (s.body?.ready || s.body?.checks?.find((x) => x.id === "data_connection")?.ok) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const build = BUILDS[platformKey()];
  const file = join(installDir(home), build.file);
  const sum = existsSync(file) ? await sha256Of(file) : "missing";
  console.log(`fetched file: ${existsSync(file) ? "present" : "MISSING"}; fingerprint ${sum === build.sha256 ? "matches the pinned one" : `DOES NOT MATCH (${sum})`}; leftovers: ${readdirSync(installDir(home)).filter((f) => /\.part$|progress/.test(f)).join(", ") || "none"}`);
  const answer = await call("run_playbook", { name: "metric_change", inputs: { metric: "service_level", period: "2026-W07" } });
  const top = answer.body?.result?.findings?.[0];
  console.log(`then: ${answer.error ? `FAILED: ${answer.error.slice(0, 200)}` : `the analysis ran, top finding ${top?.dimension} ${top?.value}`} (${((Date.now() - t0) / 1000).toFixed(0)} s in all)`);
  const ok = sum === build.sha256 && !answer.error && top?.value === "team_05";
  console.log(ok ? "CLEAN-MACHINE RUN PASSED" : "CLEAN-MACHINE RUN FAILED");
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
}
