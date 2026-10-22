import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const manifest = JSON.parse(readFileSync(resolve(repo, "clients", "claude-desktop", "manifest.json"), "utf-8"));
const serverSource = readFileSync(resolve(repo, "core", "mcp-server", "src", "server.ts"), "utf-8");
const registered = new Set([...serverSource.matchAll(/(?:builder|registerTool)\(\s*"([a-z_]+)"/g)].map((m) => m[1]));

test("the Desktop manifest starts the bundled server with Node's own runtime, from inside the extension, with no network at start", () => {
  const cfg = manifest.server.mcp_config;
  assert.equal(manifest.server.type, "node");
  assert.equal(cfg.command, "node", "Claude Desktop's own Node, never npx (npx needs the network and skips the bundled runtime)");
  assert.deepEqual(cfg.args, ["${__dirname}/server/causeline-mcp.mjs"]);
  assert.equal(manifest.server.entry_point, "server/causeline-mcp.mjs");
  assert.ok(!JSON.stringify(manifest).includes("npx"));
  assert.match(cfg.env.CAUSELINE_PLAYBOOKS, /^\$\{__dirname\}\/playbooks$/);
  assert.equal(cfg.env.CAUSELINE_HOME, "${user_config.projects_folder}");
});

test("the settings ask for a folder with a sensible default and an optional project, and nothing secret", () => {
  const u = manifest.user_config;
  assert.equal(u.projects_folder.type, "directory");
  assert.equal(u.projects_folder.default, "${HOME}/Causeline", "the same place the server uses when it is not told");
  assert.equal(u.projects_folder.required, true);
  assert.equal(u.bigquery_project.required, false);
  assert.equal(u.bigquery_project.default, "", "an unset optional value must still fill in the variable, not leave it unreplaced");
  assert.ok(Object.values(u).every((v) => (v as { sensitive?: boolean }).sensitive === undefined), "no credential is asked for: sign-in is Google's own");
});

test("it supports the platforms Claude Desktop runs on, needs the Node it ships, and every tool it lists exists", () => {
  assert.deepEqual([...manifest.compatibility.platforms].sort(), ["darwin", "win32"]);
  assert.match(manifest.compatibility.runtimes.node, />=20/);
  for (const t of manifest.tools) assert.ok(registered.has(t.name), `${t.name} is a tool of the server`);
  assert.match(manifest.manifest_version, /^0\.\d$/);
  assert.ok(manifest.description.length > 60);
});
