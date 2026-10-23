import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { useOwnSignIn } from "@causeline/connect-bigquery";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { causelineHome, VERSION } from "@causeline/runner";
import { loadConfig } from "./config.js";
import { runGuard } from "./guard-cli.js";
import { codexPaths, installCodex, uninstallCodex, type LaunchCommand, type Report } from "./install.js";
import { createServer } from "./server.js";
import { setupCheck } from "./setup-check.js";
import { ToolboxManager } from "./toolbox.js";

declare const __CAUSELINE_PLAYBOOKS__: Record<string, string> | undefined;

const USAGE = `causeline-mcp ${VERSION}
  causeline-mcp                      serve over stdio (what an AI assistant starts)
  causeline-mcp doctor               say whether this computer is ready, in plain words
  causeline-mcp install codex        set Causeline up in Codex (backs up what it changes)
  causeline-mcp uninstall codex      remove exactly what install added
  causeline-mcp --version`;

/** When this is the single-file program, the core playbooks travel inside it: write them where the server reads them. */
export function useEmbeddedPlaybooks(env: NodeJS.ProcessEnv = process.env): void {
  const embedded = typeof __CAUSELINE_PLAYBOOKS__ !== "undefined" ? __CAUSELINE_PLAYBOOKS__ : undefined;
  if (!embedded || env.CAUSELINE_PLAYBOOKS) return;
  const dir = join(causelineHome(env), `playbooks-${VERSION}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(embedded)) writeFileSync(join(dir, name), text, "utf-8");
  env.CAUSELINE_PLAYBOOKS = dir;
}

/** How Codex should start this program: the program itself when it is the single file, else Node with this script. */
export function launchCommand(): LaunchCommand {
  const exe = process.execPath;
  const isNode = /^node(\.exe)?$/i.test(basename(exe));
  return isNode ? { command: exe, args: [process.argv[1]] } : { command: exe, args: [] };
}

const say = (r: Report) => {
  for (const c of r.changed) console.log(`- ${c}`);
  for (const b of r.backups) console.log(`  (the original was kept as ${basename(b)})`);
  for (const n of r.next) console.log(n);
};

async function serve(): Promise<void> {
  useEmbeddedPlaybooks();
  // stdout carries the MCP protocol, so anything human-readable goes to stderr
  const config = loadConfig();
  useOwnSignIn(config.home ?? causelineHome()); // Causeline's own Google sign-in, when the person has made one, before any data connection starts
  const toolbox = new ToolboxManager(config);
  const server = createServer(config, toolbox);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await toolbox.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(new StdioServerTransport());
  console.error(`causeline-mcp serving ${config.packDir}`);
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === "--version" || cmd === "version") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "guard") {
    await runGuard();
    return 0;
  }
  if (cmd === "doctor") {
    useEmbeddedPlaybooks();
    const config = loadConfig();
    const toolbox = new ToolboxManager(config);
    const r = await setupCheck(config, toolbox.installer);
    console.log(`Causeline ${r.version}`);
    for (const c of r.checks) console.log(`${c.ok ? "ok  " : "NO  "} ${c.say}${c.todo ? `\n     To do: ${c.todo}` : ""}`);
    console.log(r.ready ? "Everything is ready." : "Not ready yet: see the lines marked NO.");
    return r.ready ? 0 : 1;
  }
  if (cmd === "install" || cmd === "uninstall") {
    if (arg !== "codex") {
      console.error(`${cmd} needs a client name: codex\n${USAGE}`);
      return 2;
    }
    try {
      const paths = codexPaths();
      const home = process.env.CAUSELINE_HOME?.trim();
      say(cmd === "install" ? installCodex({ paths, launch: launchCommand(), env: { ...(home ? { CAUSELINE_HOME: home } : {}), ...(process.env.CAUSELINE_PLAYBOOKS?.trim() ? { CAUSELINE_PLAYBOOKS: process.env.CAUSELINE_PLAYBOOKS.trim() } : {}) } }) : uninstallCodex({ paths }));
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  if (cmd !== undefined && cmd !== "serve") {
    console.error(`I do not know "${cmd}".\n${USAGE}`);
    return 2;
  }
  await serve();
  return -1; // serving: the process lives until the client closes it
}
