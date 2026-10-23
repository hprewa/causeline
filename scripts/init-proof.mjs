#!/usr/bin/env node
// The engineer path in a temporary home: `causeline init` for Codex and Claude Code, twice each (the second run must change nothing),
// then the settings it wrote are read back. Nothing outside the temporary folder is touched.
//   node scripts/init-proof.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "init-proof-"));
const env = { ...process.env, HOME: work, USERPROFILE: work, CODEX_HOME: join(work, ".codex"), CLAUDE_CONFIG_DIR: join(work, ".claude"), CAUSELINE_HOME: join(work, "Causeline") };
const init = (...args) => spawnSync(process.execPath, [join(repo, "bin", "causeline.mjs"), "init", "--no-check", ...args], { env, encoding: "utf-8" });
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) process.exitCode = 1;
};

const none = init();
check(none.status === 0 || none.status === 2, "init with no client names what it found, or says what to choose");

const read = () => readFileSync(join(env.CODEX_HOME, "config.toml"), "utf-8");
const a = init("--client", "codex");
check(a.status === 0, "codex: init finished");
const first = read();
check(first.includes("[mcp_servers.causeline]") && first.includes("CAUSELINE_PLAYBOOKS"), "codex: the server entry and the playbooks path are in Codex's settings");
check(existsSync(join(work, ".agents", "skills", "causeline-build", "SKILL.md")), "codex: the four skills were added");
init("--client", "codex");
check(read() === first, "codex: a second init changes nothing");
check(existsSync(join(env.CAUSELINE_HOME, "engineer", "causeline-mcp.mjs")), "a stable copy of the server is in the Causeline folder, not in the checkout");

const c = init("--client", "claude-code");
check(c.status === 0, "claude-code: init finished");
const listed = spawnSync("claude", ["plugin", "list"], { env, encoding: "utf-8", shell: process.platform === "win32" });
check(/causeline@causeline/.test(listed.stdout) && /enabled/.test(listed.stdout), "claude-code: the plugin is installed and enabled");
console.log(process.exitCode ? "FAILED" : "PASSED");
