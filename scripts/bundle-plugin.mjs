#!/usr/bin/env node
// Assemble the Claude Code plugin: bundle causeline-mcp into one self-contained file and copy the
// shared skills and core playbooks in. A plugin is copied when installed, so it cannot refer
// to anything outside its own directory. Run after `npm run build` (npm run bundle:plugin does both).
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const plugin = resolve("clients", "claude-code");
if (!existsSync(join(plugin, ".claude-plugin", "plugin.json"))) throw new Error(`${plugin} is not a plugin directory`);

const entry = resolve("core", "mcp-server", "dist", "src", "main.js");
if (!existsSync(entry)) throw new Error("core/mcp-server is not built; run `npm run build` first");

const outfile = join(plugin, "server", "causeline-mcp.mjs");
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  // some bundled dependencies are CommonJS and call require()
  banner: { js: "import { createRequire as __causelineCreateRequire } from 'node:module'; const require = __causelineCreateRequire(import.meta.url);" },
  // the guides travel inside the server file: a client that cannot carry skills still gets the same text from get_guide
  define: { __CAUSELINE_GUIDES__: JSON.stringify(Object.fromEntries(["build", "investigate", "explore", "onboard"].map((n) => [`causeline-${n}`, readFileSync(resolve("skills", `causeline-${n}`, "SKILL.md"), "utf-8")]))) },
  logLevel: "warning",
});

for (const dir of ["skills", "playbooks"]) {
  rmSync(join(plugin, dir), { recursive: true, force: true });
  mkdirSync(join(plugin, dir), { recursive: true });
  cpSync(resolve(dir), join(plugin, dir), { recursive: true });
}
console.log(`plugin assembled in ${plugin} (server ${(statSync(outfile).size / 1e6).toFixed(1)} MB)`);
