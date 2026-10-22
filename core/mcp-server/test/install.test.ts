import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPaths, installCodex, tomlBlock, uninstallCodex } from "../src/install.js";

const launch = { command: "C:\\Program Files\\Causeline\\causeline-mcp.exe", args: [] as string[] };
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "codex-"));
  const paths = codexPaths({} as never, root);
  return { root, paths, config: join(paths.codex, "config.toml"), agents: join(paths.codex, "AGENTS.md"), hooks: join(paths.codex, "hooks.json") };
};
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/causeline-backup/.test(e.name)) out[p.slice(dir.length)] = readFileSync(p, "utf-8");
    }
  };
  walk(dir);
  return out;
};

test("a fresh install writes the server entry, the instructions, four skills and the guard, and says what to do next", () => {
  const t = setup();
  const r = installCodex({ paths: t.paths, launch });
  assert.equal(r.changed.length, 3 + 4);
  assert.deepEqual(r.backups, [], "nothing existed to back up");
  const toml = readFileSync(t.config, "utf-8");
  assert.match(toml, /\[mcp_servers\.causeline\]/);
  assert.match(toml, /command = 'C:\\Program Files\\Causeline\\causeline-mcp\.exe'/, "a Windows path is a literal string, with no escapes");
  assert.match(toml, /startup_timeout_sec = 60/);
  assert.match(readFileSync(t.agents, "utf-8"), /call get_guide with the name that fits/);
  for (const n of ["build", "investigate", "explore", "onboard"]) assert.match(readFileSync(join(t.paths.skills, `causeline-${n}`, "SKILL.md"), "utf-8"), new RegExp(`name: causeline-${n}`));
  const hooks = JSON.parse(readFileSync(t.hooks, "utf-8"));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, "Bash");
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /^"C:\\Program Files\\Causeline\\causeline-mcp\.exe" guard$/);
  assert.ok(r.next.some((n) => /Restart Codex/.test(n)) && r.next.some((n) => /\/hooks/.test(n)));
});

test("installing again changes nothing and makes no backup", () => {
  const t = setup();
  installCodex({ paths: t.paths, launch });
  const before = snapshot(t.root);
  const again = installCodex({ paths: t.paths, launch });
  assert.deepEqual(again.changed, []);
  assert.deepEqual(again.backups, []);
  assert.deepEqual(snapshot(t.root), before);
  assert.deepEqual(again.next, ["Causeline was already set up for Codex; nothing changed."]);
});

test("a person's own settings, instructions and hooks are kept byte for byte outside Causeline's block, backed up, and restored exactly by uninstall", () => {
  const t = setup();
  mkdirSync(t.paths.codex, { recursive: true });
  const toml = '# my settings\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "other"\n';
  const md = "# My rules\n\nBe brief.\n";
  const hooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "mine" }] }] }, description: "mine" }, null, 2) + "\n";
  writeFileSync(t.config, toml);
  writeFileSync(t.agents, md);
  writeFileSync(t.hooks, hooks);
  const r = installCodex({ paths: t.paths, launch });
  assert.equal(r.backups.length, 3, "each changed file was copied aside first");
  assert.ok(readFileSync(t.config, "utf-8").startsWith(toml), "their settings are untouched");
  assert.ok(readFileSync(t.agents, "utf-8").startsWith(md));
  const h = JSON.parse(readFileSync(t.hooks, "utf-8"));
  assert.equal(h.hooks.PreToolUse.length, 2);
  assert.equal(h.description, "mine");
  assert.deepEqual(h.hooks.PreToolUse[0], { matcher: "apply_patch", hooks: [{ type: "command", command: "mine" }] });

  const u = uninstallCodex({ paths: t.paths });
  assert.ok(u.changed.length >= 7);
  assert.equal(readFileSync(t.config, "utf-8"), toml, "back to exactly what it was");
  assert.equal(readFileSync(t.agents, "utf-8"), md);
  assert.deepEqual(JSON.parse(readFileSync(t.hooks, "utf-8")), JSON.parse(hooks));
  assert.deepEqual(readdirSync(t.paths.skills), [], "its skills are gone");
});

test("uninstall from a fresh install leaves no file it made, and a skill folder that is not Causeline's is never removed", () => {
  const t = setup();
  installCodex({ paths: t.paths, launch });
  uninstallCodex({ paths: t.paths });
  assert.deepEqual(Object.keys(snapshot(t.root)), [], "every file it created is gone");

  const mine = join(t.paths.skills, "causeline-notes");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "SKILL.md"), "mine");
  installCodex({ paths: t.paths, launch });
  uninstallCodex({ paths: t.paths });
  assert.equal(readFileSync(join(mine, "SKILL.md"), "utf-8"), "mine");
});

test("things it cannot do safely are refused with a reason and nothing is changed", () => {
  const t = setup();
  mkdirSync(t.paths.codex, { recursive: true });
  writeFileSync(t.config, '[mcp_servers.causeline]\ncommand = "someone elses"\n');
  assert.throws(() => installCodex({ paths: t.paths, launch }), /already have a server called causeline that this did not add/);
  assert.equal(readFileSync(t.config, "utf-8"), '[mcp_servers.causeline]\ncommand = "someone elses"\n');
  assert.equal(existsSync(t.agents), false, "nothing was written before the refusal");

  const u = setup();
  mkdirSync(join(u.paths.skills, "causeline-build"), { recursive: true });
  assert.throws(() => installCodex({ paths: u.paths, launch }), /causeline-build is already in your skills and is not Causeline's own/);

  const v = setup();
  mkdirSync(v.paths.codex, { recursive: true });
  writeFileSync(v.hooks, "{ not json");
  assert.throws(() => installCodex({ paths: v.paths, launch }), /hooks file is not valid JSON/);
  assert.equal(readFileSync(v.hooks, "utf-8"), "{ not json");

  const w = setup();
  mkdirSync(w.paths.codex, { recursive: true });
  writeFileSync(w.config, "# >>> causeline (written by `causeline-mcp install codex`; `uninstall codex` removes it) >>>\n[mcp_servers.causeline]\n");
  assert.throws(() => installCodex({ paths: w.paths, launch }), /no end marker/);
});

test("an update replaces only its own block (a moved program, a new home), and the settings carry the environment when one is given", () => {
  const t = setup();
  installCodex({ paths: t.paths, launch });
  installCodex({ paths: t.paths, launch: { command: "/opt/causeline/causeline-mcp", args: [] }, env: { CAUSELINE_HOME: "/data/causeline" } });
  const toml = readFileSync(t.config, "utf-8");
  assert.equal((toml.match(/\[mcp_servers\.causeline\]/g) ?? []).length, 1);
  assert.match(toml, /command = '\/opt\/causeline\/causeline-mcp'/);
  assert.match(toml, /\[mcp_servers\.causeline\.env\]\nCAUSELINE_HOME = '\/data\/causeline'/);
  assert.equal(JSON.parse(readFileSync(t.hooks, "utf-8")).hooks.PreToolUse.length, 1, "the guard was updated, not added twice");
  assert.match(tomlBlock({ command: "node", args: ["/x/causeline-mcp.mjs"] }, {}), /args = \['\/x\/causeline-mcp\.mjs'\]/);
});
