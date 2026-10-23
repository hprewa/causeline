#!/usr/bin/env node
// The engineer path (run through bin/causeline.mjs): `npx github:hprewa/causeline init [--client codex|claude-code|desktop] [--dry-run] [--no-open]`.
// It builds what is needed from this checkout, puts a stable copy of the server in the Causeline home (an npx checkout is a cache that can
// go away), and sets the chosen client up. Nothing is published anywhere. Everything it writes is under the Causeline home, the client's own
// settings (through the client's own command, or the Codex installer that backs up what it changes) or the `dist` folder of this checkout.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";

const repo = resolve(import.meta.dirname, "..");
// the same rule as the runner's causelineHome(); this file runs before anything is built
const causelineHome = () => resolve(process.env.CAUSELINE_HOME?.trim() || join(homedir(), "Causeline"));
const win = process.platform === "win32";
const CLIENTS = ["codex", "claude-code", "desktop"];

const out = (s = "") => console.log(s);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", shell: win && /^(npm|npx|claude|codex)$/.test(cmd), ...opts });
const onPath = (name) => {
  const exts = win ? [".cmd", ".exe", ".bat", ""] : [""];
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && exts.some((e) => existsSync(join(d, name + e))));
};

export function parseInit(argv) {
  const o = { clients: [], dryRun: false, open: true, check: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") o.clients.push(argv[++i]);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--no-open") o.open = false;
    else if (a === "--no-check") o.check = false;
    else throw new Error(`I do not know "${a}". Use: init [--client codex|claude-code|desktop] [--dry-run] [--no-open] [--no-check]`);
  }
  const bad = o.clients.find((c) => !CLIENTS.includes(c));
  if (bad) throw new Error(`"${bad}" is not a client I know. Choose from: ${CLIENTS.join(", ")}`);
  return o;
}

export async function init(argv) {
  const o = parseInit(argv);
  const home = causelineHome();
  const stable = join(home, "engineer");
  let clients = o.clients;
  if (clients.length === 0) {
    clients = [onPath("claude") ? "claude-code" : null, onPath("codex") ? "codex" : null].filter(Boolean);
    if (clients.length === 0) {
      out("I did not find Claude Code or Codex on this computer. Say which to set up:  causeline init --client codex|claude-code|desktop");
      return 2;
    }
    out(`Found: ${clients.join(" and ")}.`);
  }
  if (o.dryRun) {
    out(`Would set up ${clients.join(", ")}; the server and playbooks would be copied to ${stable}.`);
    return 0;
  }

  // 1. build from this checkout, once
  if (!existsSync(join(repo, "core", "mcp-server", "dist", "src", "main.js"))) {
    out("Building Causeline (a minute or two the first time)...");
    if (run("npm", ["run", "build"], { cwd: repo }).status !== 0) throw new Error("the build failed; the lines above say why");
  }
  out("Assembling the server...");
  if (run(process.execPath, [join(repo, "scripts", "bundle-plugin.mjs")], { cwd: repo }).status !== 0) throw new Error("assembling the server failed");

  // 2. a stable copy of the server and the core playbooks
  rmSync(stable, { recursive: true, force: true });
  mkdirSync(stable, { recursive: true });
  const plugin = join(repo, "clients", "claude-code");
  cpSync(join(plugin, "server", "causeline-mcp.mjs"), join(stable, "causeline-mcp.mjs"));
  cpSync(join(repo, "playbooks"), join(stable, "playbooks"), { recursive: true });
  const server = join(stable, "causeline-mcp.mjs");
  const env = { ...process.env, CAUSELINE_PLAYBOOKS: join(stable, "playbooks") };

  for (const c of clients) {
    out();
    if (c === "codex") {
      out("Setting up Codex...");
      const r = run(process.execPath, [server, "install", "codex"], { env });
      if (r.status !== 0) throw new Error("setting up Codex failed; the lines above say why");
    } else if (c === "claude-code") {
      out("Setting up Claude Code...");
      const market = join(stable, "claude-marketplace");
      mkdirSync(join(market, ".claude-plugin"), { recursive: true });
      cpSync(plugin, join(market, "causeline"), { recursive: true });
      writeFileSync(
        join(market, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ name: "causeline", owner: { name: "Harsh" }, metadata: { description: "Root-cause analysis you can audit." }, plugins: [{ name: "causeline", source: "./causeline", description: "Root-cause analysis you can audit." }] }, null, 2) + "\n",
      );
      if (onPath("claude")) {
        const a = run("claude", ["plugin", "marketplace", "add", market]);
        const b = a.status === 0 ? run("claude", ["plugin", "install", "causeline@causeline"]) : a;
        if (b.status !== 0) throw new Error("Claude Code would not add it; the lines above say why");
        out("Done. Start a new Claude Code session and ask it to set up Causeline.");
      } else {
        out("Claude Code is not on this computer's path. When it is, run these two:");
        out(`  claude plugin marketplace add "${market}"`);
        out("  claude plugin install causeline@causeline");
      }
    } else {
      out("Building the Claude Desktop extension...");
      if (run(process.execPath, [join(repo, "scripts", "bundle-desktop.mjs")], { cwd: repo }).status !== 0) throw new Error("building the extension failed");
      const file = readdirSync(join(repo, "dist")).find((f) => f.endsWith(".mcpb"));
      if (!file) throw new Error("the extension file was not made");
      cpSync(join(repo, "dist", file), join(stable, file));
      out(`Made ${join(stable, file)}. Opening it in Claude Desktop lets you install it.`);
      if (o.open) {
        if (win) spawnSync("cmd", ["/c", "start", "", join(stable, file)], { stdio: "ignore" });
        else spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [join(stable, file)], { stdio: "ignore" });
      }
    }
  }

  out();
  if (o.check) {
    out("Checking this computer...");
    run(process.execPath, [server, "doctor"], { env });
  }
  out();
  out(`Everything Causeline keeps for you is in ${home}.${clients.includes("codex") ? ` To remove it from Codex: node "${server}" uninstall codex` : ""}`);
  return 0;
}
