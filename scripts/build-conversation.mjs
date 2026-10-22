#!/usr/bin/env node
// A live build conversation: a Claude Code agent (with the Causeline plugin) talks to a simulated user until the pack is
// built, or the turns run out. The simulated user is a second, tool-less model call that is told only what the persona file says.
//   node scripts/build-conversation.mjs --persona packs/complaints/evals/build-persona.md [--folder <empty dir>] [--turns 30] [--model <m>]
//   --no-pack   start every turn with no project open (as a new session does), so the assistant must open the project it made; needs CAUSELINE_HOME set
//   node scripts/build-conversation.mjs --persona <file> --continue runs/build-conversation-<time>.json   carry on a conversation that stopped (for example at a usage limit)
// Needs `claude` on the PATH and a sign-in; spends model tokens (each turn's cost is printed). Writes the transcript to runs/.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runClaudeCode } from "../core/eval/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const flag = (name, dflt) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : dflt);
const persona = readFileSync(resolve(flag("persona")), "utf-8");
const folder = resolve(flag("folder", flag("continue") ? JSON.parse(readFileSync(resolve(flag("continue")), "utf-8")).folder : mkdtempSync(join(tmpdir(), "build-conversation-"))));
mkdirSync(folder, { recursive: true });
const maxTurns = Number(flag("turns", "30"));
const model = flag("model");
const toolbox = existsSync(join(repo, process.platform === "win32" ? "toolbox.exe" : "toolbox")) ? join(repo, process.platform === "win32" ? "toolbox.exe" : "toolbox") : undefined;
const opening = flag("opening", "Hi. I'd like to look at consumer complaints data and understand why the numbers move. Can you help me set that up?");

const quote = (a) => (/^[\w./:=@%+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
/** The simulated user: one model call with no tools. */
function simulateUser(transcript) {
  const history = transcript.map((t) => `${t.role === "agent" ? "ASSISTANT" : "YOU"}: ${t.text}`).join("\n\n");
  const prompt = `${persona}\n\n---\nThe conversation so far:\n\n${history}\n\n---\nWrite your next reply as the user, following your instructions. Reply with only the words you would type, nothing else. If the assistant has answered your question about the Equifax week (after the setup was finished) and you have nothing more to ask, reply with exactly: [END]`;
  const args = ["-p", "--output-format", "json", "--max-turns", "1", "--tools", "", ...(model ? ["--model", model] : [])];
  const win = process.platform === "win32";
  return new Promise((res, rej) => {
    const child = win ? spawn(["claude", ...args.map(quote)].join(" "), { shell: true, stdio: ["pipe", "pipe", "pipe"], cwd: folder }) : spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: folder });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.once("error", rej);
    child.once("close", () => {
      try {
        const j = JSON.parse(out);
        res({ text: String(j.result ?? "").trim(), cost: Number(j.total_cost_usd ?? 0) });
      } catch {
        rej(new Error(`the simulated user did not answer: ${out.slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

const transcript = [];
const turns = [];
let user = opening;
let session;
let first = 1;
if (flag("continue")) {
  // pick up where a stopped conversation left off: its good turns, then the simulated user's next reply
  const prev = JSON.parse(readFileSync(resolve(flag("continue")), "utf-8"));
  session = prev.session;
  for (const t of prev.turns.filter((x) => !x.error)) {
    turns.push(t);
    transcript.push({ role: "user", text: t.user }, { role: "agent", text: t.agent });
  }
  first = turns.length + 1;
  user = (await simulateUser(transcript)).text;
}
let agentCost = 0;
let userCost = 0;
console.log(`folder: ${folder}`);
for (let i = first; i <= maxTurns; i++) {
  console.log(`\n--- turn ${i} ---\nUSER: ${user}`);
  transcript.push({ role: "user", text: user });
  const run = await runClaudeCode({
    question: user,
    pluginDir: join(repo, "clients", "claude-code"),
    packDir: folder,
    toolbox,
    bare: false,
    model,
    resume: session,
    env: { CAUSELINE_NO_BROWSER: "1", ...(process.argv.includes("--no-pack") ? { CAUSELINE_PACK: "" } : {}) },
    maxTurns: 40,
    timeoutMs: 20 * 60_000,
  });
  session = run.sessionId ?? session;
  agentCost = Math.max(agentCost, run.metrics.costUsd); // a resumed session reports its cost so far, not this turn's
  const tools = run.toolCalls.map((t) => t.name.replace("mcp__plugin_causeline_causeline-mcp__", ""));
  console.log(`AGENT (${tools.length} tool calls: ${tools.join(", ") || "none"}; $${run.metrics.costUsd.toFixed(2)} so far${run.error ? `; ERROR ${run.error}` : ""}):\n${run.narrative}`);
  transcript.push({ role: "agent", text: run.narrative });
  turns.push({ turn: i, user, agent: run.narrative, tools: run.toolCalls.map((t) => ({ name: t.name.replace("mcp__plugin_causeline_causeline-mcp__", ""), input: t.input, output: t.output })), costUsd: run.metrics.costUsd, ms: run.metrics.ms, error: run.error });
  if (run.error) break; // a stopped session (a usage limit, a crash) is not a turn; carry on later with --continue
  const next = await simulateUser(transcript);
  userCost += next.cost;
  if (/^\[END\]/.test(next.text)) {
    console.log("\nUSER: [END]");
    break;
  }
  user = next.text;
}
mkdirSync(join(repo, "runs"), { recursive: true });
const file = join(repo, "runs", `build-conversation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ folder, session, agentCostUsd: agentCost, simulatedUserCostUsd: userCost, turns }, null, 2));
console.log(`\nagent cost $${agentCost.toFixed(2)}, simulated user $${userCost.toFixed(2)}; transcript: ${file}`);
