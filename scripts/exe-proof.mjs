#!/usr/bin/env node
// The single executable on a machine with no Node: asked its version and for `doctor` with a PATH that holds nothing but the system folder,
// used over the MCP protocol (guides, projects, the first-run fetch of the data connection software, an analysis on the example data), and
// used to set Codex up and remove it again in a temporary home.
//   npm run bundle:exe && node scripts/exe-proof.mjs
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { registerProject } from "../core/builder/dist/src/index.js";
import { loadCases, prepareCase } from "../core/eval/dist/src/index.js";
import { BUILDS, installDir, platformKey, sha256Of } from "../core/runner/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const name = `causeline-mcp-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const built = join(repo, "dist", name);
if (!existsSync(built)) throw new Error("run `npm run bundle:exe` first");
const work = mkdtempSync(join(tmpdir(), "exe-proof-"));
const exe = join(work, "program", name);
mkdirSync(join(work, "program"), { recursive: true });
cpSync(built, exe);

// no Node, no Toolbox: only the operating system's own folder
const sys = process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "/usr/bin";
const home = join(work, "home");
const userHome = join(work, "user");
mkdirSync(userHome, { recursive: true });
const env = { PATH: sys, SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", HOME: userHome, USERPROFILE: userHome, CAUSELINE_HOME: home };
const failures = [];
const check = (n, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(n);
};
const run = (args) => spawnSync(exe, args, { env, cwd: work, encoding: "utf-8" });
const nodeOnPath = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], { env: { PATH: sys }, cwd: work, encoding: "utf-8" });
check("there is no Node on the PATH the program runs with", nodeOnPath.status !== 0);

const v = run(["--version"]);
check("it says its version", v.status === 0 && /^\d+\.\d+\.\d+/.test(v.stdout.trim()), v.stdout.trim());
const d = run(["doctor"]);
check("doctor says in plain words that it is not ready yet and what is missing", d.status === 1 && /preparing the data connection|has not been fetched/.test(d.stdout) && /ok   Your Causeline folder is there/.test(d.stdout), d.stdout.split("\n").filter((l) => /^(ok|NO)/.test(l)).join(" | ").slice(0, 160));
check("doctor shows no folder path", !d.stdout.includes(work));
const bad = run(["frobnicate"]);
check("an unknown command is refused with the list of commands", bad.status === 2 && /causeline-mcp install codex/.test(bad.stderr));

// the example project, registered the way an earlier one would be
const pack = resolve(repo, "packs", "contact-centre");
const packDir = await prepareCase(pack, loadCases(pack, ["understaffed_team"])[0], join(work, "pack"), false);
registerProject(home, "Example", packDir);

const client = new Client({ name: "exe-proof", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: exe, args: [], env, cwd: work }));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  return { error: r.isError ? r.content?.[0]?.text : undefined, body: r.structuredContent };
};
try {
  const t0 = Date.now();
  check("the guidance is told to the assistant", /call get_guide with the name that fits/.test(client.getInstructions() ?? ""));
  check("a guide is served from inside the program", /Exploring/.test((await call("get_guide", { name: "explore" })).body?.text ?? ""));
  check("the example project is listed by name", (await call("list_projects")).body?.projects?.some((p) => p.name === "Example"));
  await call("open_project", { name: "Example" });
  const first = await call("run_playbook", { name: "metric_change", inputs: { metric: "service_level", period: "2026-W07" } });
  check("a question needing the data connection says it is being prepared", /preparing the data connection/.test(first.error ?? ""), (first.error ?? "").slice(0, 80));
  for (let i = 0; i < 240; i++) {
    if ((await call("check_setup")).body?.checks?.find((c) => c.id === "data_connection")?.ok) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const b = BUILDS[platformKey()];
  const file = join(installDir(home), b.file);
  check("the fetched software matches its pinned fingerprint", existsSync(file) && (await sha256Of(file)) === b.sha256);
  const answer = await call("run_playbook", { name: "metric_change", inputs: { metric: "service_level", period: "2026-W07" } });
  check("the analysis runs (the playbooks came out of the program)", !answer.error && answer.body?.result?.findings?.[0]?.value === "team_05", (answer.error ?? "").slice(0, 120));
  check("the playbooks were written into the Causeline folder, not beside the program", readdirSync(home).some((f) => /^playbooks-/.test(f)));
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s for the session`);
} finally {
  await client.close();
}

// Codex: set up and remove in a home of its own, with a file the person already had
const codex = join(userHome, ".codex");
mkdirSync(codex, { recursive: true });
const mine = 'model = "x"\n';
writeFileSync(join(codex, "config.toml"), mine);
const inst = run(["install", "codex"]);
check("install codex says what it changed and what to do next", inst.status === 0 && /added Causeline to your Codex settings/.test(inst.stdout) && /Restart Codex/.test(inst.stdout), inst.stdout.split("\n").length + " lines");
const toml = readFileSync(join(codex, "config.toml"), "utf-8");
check("the server entry points at the program itself, with no Node", toml.startsWith(mine) && toml.includes(`command = '${exe}'`) && /args = \[\]/.test(toml));
const hook = JSON.parse(readFileSync(join(codex, "hooks.json"), "utf-8")).hooks.PreToolUse[0].hooks[0].command;
check("the guard in the hook is the program too", hook.includes("guard") && hook.includes(name));
const guarded = spawnSync(exe, ["guard"], { env, cwd: work, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sqlite3 data/x.db 'select 1'" } }), encoding: "utf-8" });
check("the guard blocks a database command line, from the program, with no Node", /"permissionDecision":"deny"/.test(guarded.stdout), guarded.stdout.slice(0, 100).trim());
const ok = spawnSync(exe, ["guard"], { env, cwd: work, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }), encoding: "utf-8" });
check("and lets an ordinary command through", ok.stdout.trim() === "{}");
const un = run(["uninstall", "codex"]);
check("uninstall codex puts the file back exactly as it was and removes what it made", un.status === 0 && readFileSync(join(codex, "config.toml"), "utf-8") === mine && !existsSync(join(codex, "hooks.json")) && !existsSync(join(userHome, ".agents", "skills", "causeline-build")));
console.log(failures.length === 0 ? "SINGLE EXECUTABLE RUN PASSED" : `SINGLE EXECUTABLE RUN FAILED: ${failures.join("; ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
