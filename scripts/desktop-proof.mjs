#!/usr/bin/env node
// What Claude Desktop does with the extension, as far as it can be done on this computer: unpack the .mcpb, read its manifest, fill in the
// variables the way the manifest says, start the server with exactly that command, arguments and environment (and a PATH with nothing on
// it but Node), and use it through the MCP protocol: the tools and guides, a project made in the chosen folder, the first-run fetch of the
// data connection software, and a question answered on the example data.
//   npm run bundle:desktop && node scripts/desktop-proof.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { registerProject } from "../core/builder/dist/src/index.js";
import { loadCases, prepareCase } from "../core/eval/dist/src/index.js";
import { BUILDS, installDir, platformKey, sha256Of } from "../core/runner/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8")).version;
const file = join(repo, "dist", `causeline-${version}.mcpb`);
if (!existsSync(file)) throw new Error("run `npm run bundle:desktop` first");

const work = mkdtempSync(join(tmpdir(), "desktop-proof-"));
const unpacked = join(work, "extension");
const un = spawnSync("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "unpack", file, unpacked], { cwd: repo, encoding: "utf-8", shell: process.platform === "win32" });
if (un.status !== 0) throw new Error(`could not unpack: ${un.stdout}${un.stderr}`);
const manifest = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf-8"));
console.log(`unpacked ${manifest.name} ${manifest.version}: ${readdirSync(unpacked).join(", ")}`);

// the user's answers to the settings screen: a folder of their choosing, and no BigQuery project
const home = join(work, "home");
const answers = { projects_folder: home, bigquery_project: "" };
const fill = (text) => String(text).replaceAll("${__dirname}", unpacked).replace(/\$\{user_config\.(\w+)\}/g, (_, k) => answers[k] ?? "");
const cfg = manifest.server.mcp_config;
const node = process.execPath;
const clean = [resolve(node, ".."), process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "/usr/bin"].filter(existsSync).join(delimiter);
const env = { PATH: clean, SystemRoot: process.env.SystemRoot ?? "", HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "", TEMP: process.env.TEMP ?? "", ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, fill(v)])) };
const command = cfg.command === "node" ? node : cfg.command;
const args = cfg.args.map(fill);
console.log(`started as: ${cfg.command} ${cfg.args.join(" ")} (variables filled in; PATH holds only Node)`);
const empty = spawnSync(process.platform === "win32" ? "where" : "which", ["toolbox"], { env: { PATH: clean }, cwd: work, encoding: "utf-8" });
if (empty.status === 0) throw new Error("Toolbox is on the clean PATH; the run would prove nothing");

// an example project, registered the way a project made earlier would be
const pack = resolve(repo, "packs", "contact-centre");
const packDir = await prepareCase(pack, loadCases(pack, ["understaffed_team"])[0], join(work, "pack"), false);
registerProject(home, "Example", packDir);

const client = new Client({ name: "desktop-proof", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command, args, env, cwd: work }));
const call = async (name, a = {}) => {
  const r = await client.callTool({ name, arguments: a });
  return { error: r.isError ? r.content?.[0]?.text : undefined, body: r.structuredContent };
};
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
try {
  const t0 = Date.now();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of manifest.tools.map((x) => x.name)) check(`tool ${t} is offered`, tools.includes(t));
  check("the guidance is told to the assistant", /call get_guide with the name that fits/.test(client.getInstructions() ?? ""));
  const guide = await call("get_guide", { name: "explore" });
  check("a guide is served from inside the extension", /Exploring/.test(guide.body?.text ?? ""));
  const none = await call("list_projects");
  check("the project registered in the chosen folder is listed, by name", none.body?.projects?.some((p) => p.name === "Example"), JSON.stringify(none.body?.projects?.map((p) => p.name)));
  check("no folder path is given to the assistant", !JSON.stringify(none.body).includes(home));
  const made = await call("create_project", { name: "Weekly review" });
  check("a new project is made and opened", made.body?.created === "Weekly review");
  check("it is kept in the folder chosen in the settings", readdirSync(home).includes("weekly-review"));
  await call("open_project", { name: "Example" });
  const setup0 = await call("check_setup");
  const conn0 = setup0.body?.checks?.find((c) => c.id === "data_connection");
  check("the first check says the data connection software is being prepared", !conn0?.ok && /preparing the data connection/.test(conn0?.say ?? ""), conn0?.say?.slice(0, 80));
  const early = await call("run_playbook", { name: "metric_change", inputs: { metric: "service_level", period: "2026-W07" } });
  check("a question during the fetch is answered in plain words, not an error about a missing file", /preparing the data connection/.test(early.error ?? ""));
  for (let i = 0; i < 240; i++) {
    const s = await call("check_setup");
    if (s.body?.checks?.find((c) => c.id === "data_connection")?.ok) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const build = BUILDS[platformKey()];
  const fetched = join(installDir(home), build.file);
  check("the fetched software is in the chosen folder and matches its pinned fingerprint", existsSync(fetched) && (await sha256Of(fetched)) === build.sha256);
  const answer = await call("run_playbook", { name: "metric_change", inputs: { metric: "service_level", period: "2026-W07" } });
  const top = answer.body?.result?.findings?.[0];
  check("the analysis then runs on the example project", !answer.error && top?.value === "team_05", answer.error?.slice(0, 120) ?? `top finding ${top?.dimension} ${top?.value}`);
  const ex = await call("explore", { op: "rank", kpi: "service_level", by: "team", period: "2026-W07", order: "lowest", top: 1, question: "worst team?" });
  check("an exploratory read works too, and is labelled", ex.body?.label === "exploratory" && ex.body?.rows?.[0]?.node === "team_05");
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s in all`);
} finally {
  await client.close();
}
console.log(failures.length === 0 ? "DESKTOP EXTENSION RUN PASSED" : `DESKTOP EXTENSION RUN FAILED: ${failures.join("; ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
