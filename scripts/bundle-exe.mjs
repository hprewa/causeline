#!/usr/bin/env node
// Build causeline-mcp as ONE program that needs nothing installed (no Node, no npm): a Node single-executable of the same server,
// with the guides and the core playbooks inside it. Built for the platform it runs on; the release workflow runs it on each platform.
//   npm run bundle:exe
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "..");
const entry = join(repo, "core", "mcp-server", "dist", "src", "main.js");
if (!existsSync(entry)) throw new Error("run `npm run build` first");

const out = join(repo, "dist", "exe");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const guides = Object.fromEntries(["build", "investigate", "explore", "onboard"].map((n) => [`causeline-${n}`, readFileSync(join(repo, "skills", `causeline-${n}`, "SKILL.md"), "utf-8")]));
const playbooks = Object.fromEntries(readdirSync(join(repo, "playbooks")).filter((f) => f.endsWith(".yaml")).map((f) => [f, readFileSync(join(repo, "playbooks", f), "utf-8")]));

const script = join(out, "causeline-mcp.cjs");
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: script,
  // a single-executable's script is CommonJS and has no module URL: the program's own path stands in for it
  define: { "import.meta.url": "__importMetaUrl", __CAUSELINE_GUIDES__: JSON.stringify(guides), __CAUSELINE_PLAYBOOKS__: JSON.stringify(playbooks) },
  banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(process.execPath).href;' },
  logLevel: "warning",
});

const blob = join(out, "sea-prep.blob");
writeFileSync(join(out, "sea-config.json"), JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true }));
const prep = spawnSync(process.execPath, ["--experimental-sea-config", join(out, "sea-config.json")], { encoding: "utf-8" });
if (prep.status !== 0) throw new Error(`could not make the blob: ${prep.stdout}${prep.stderr}`);

// the fuse that switches the program on is named in the Node binary itself, and its name has changed between Node versions
const fuse = /NODE_SEA_FUSE_[0-9a-f]+/.exec(readFileSync(process.execPath).toString("latin1"))?.[0];
if (!fuse) throw new Error("this Node has no single-executable support");
const name = `causeline-mcp-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const exe = join(repo, "dist", name);
copyFileSync(process.execPath, exe);
const args = ["--yes", "postject@1.0.0-alpha.6", exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", fuse, ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])];
const inject = spawnSync("npx", args, { cwd: repo, encoding: "utf-8", shell: process.platform === "win32" });
if (inject.status !== 0) throw new Error(`could not inject the program: ${inject.stdout}${inject.stderr}`);
console.log(`single executable: ${exe} (${(statSync(exe).size / 1e6).toFixed(0)} MB; the script inside is ${(statSync(script).size / 1e6).toFixed(1)} MB)`);
