import { spawn } from "node:child_process";
import { Result } from "@causeline/schema";
import type { AgentMetrics } from "./table.js";

export interface AgentRun {
  narrative: string;
  toolCalls: { name: string; input: unknown; /** The start of what the tool answered, for diagnosis. */ output?: string }[];
  /** The result.json the agent's run_playbook or run_intent call returned, if any. */
  result: Result | null;
  /** What each intent tool answered, in order (the full bodies), for scoring the question the agent built. */
  intents: { tool: string; body: any }[];
  /** What each `explore` call answered, in order (the full bodies). */
  explored: any[];
  metrics: AgentMetrics;
  /** The Claude Code session, so a conversation can be continued with `resume`. */
  sessionId?: string;
  /** Set when the run failed to start or finished with an error. */
  error?: string;
  /** Servers/plugins as the session reported them, to diagnose a plugin that did not load. */
  session?: { mcpServers: unknown; pluginErrors: unknown };
}

interface StreamBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c as StreamBlock).text ?? "").join("");
  return "";
};

/** Turn Claude Code's stream-json lines into the evidence the agent score needs. */
export function parseStream(lines: string[]): AgentRun {
  const toolCalls: AgentRun["toolCalls"] = [];
  const runPlaybookIds = new Set<string>();
  const intentIds = new Map<string, string>();
  const intents: AgentRun["intents"] = [];
  const exploreIds = new Set<string>();
  const explored: any[] = [];
  let result: Result | null = null;
  let narrative = "";
  const metrics: AgentMetrics = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
  let error: string | undefined;
  let session: AgentRun["session"];
  let sessionId: string | undefined;

  for (const line of lines) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.session_id === "string") sessionId = msg.session_id;
    if (msg.type === "system" && msg.subtype === "init") {
      session = { mcpServers: msg.mcp_servers, pluginErrors: msg.plugin_errors };
    } else if (msg.type === "assistant") {
      for (const block of ((msg.message as { content?: StreamBlock[] })?.content ?? [])) {
        if (block.type === "tool_use" && block.name) {
          toolCalls.push({ name: block.name, input: block.input, ...(block.id ? { id: block.id } : {}) } as { name: string; input: unknown });
          if (/(run_playbook|run_intent)$/.test(block.name) && block.id) runPlaybookIds.add(block.id);
          if (/__explore$|^explore$/.test(block.name) && block.id) exploreIds.add(block.id);
          const intentTool = /(set_intent|run_intent|recall|start_over|get_intent)$/.exec(block.name)?.[1];
          if (intentTool && block.id) intentIds.set(block.id, intentTool);
        }
      }
    } else if (msg.type === "user") {
      for (const block of ((msg.message as { content?: StreamBlock[] })?.content ?? [])) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const call = toolCalls.find((c) => (c as { id?: string }).id === block.tool_use_id);
          if (call) call.output = textOf(block.content).slice(0, 600);
        }
        if (block.type === "tool_result" && block.tool_use_id && exploreIds.has(block.tool_use_id)) {
          const body = safeJson(textOf(block.content));
          if (body) explored.push(body);
        }
        if (block.type === "tool_result" && block.tool_use_id && intentIds.has(block.tool_use_id)) {
          const body = safeJson(textOf(block.content));
          if (body) intents.push({ tool: intentIds.get(block.tool_use_id)!, body });
        }
        if (block.type === "tool_result" && block.tool_use_id && runPlaybookIds.has(block.tool_use_id)) {
          // run_playbook returns { file, result }; accept a bare result too
          const body = safeJson(textOf(block.content)) as { result?: unknown } | null;
          const parsed = Result.safeParse(body && typeof body === "object" && "result" in body ? body.result : body);
          if (parsed.success) result = parsed.data;
        }
      }
    } else if (msg.type === "result") {
      narrative = typeof msg.result === "string" ? msg.result : "";
      metrics.costUsd = Number(msg.total_cost_usd ?? 0);
      metrics.turns = Number(msg.num_turns ?? 0);
      metrics.ms = Number(msg.duration_ms ?? 0);
      const usage = (msg.usage ?? {}) as Record<string, number>;
      metrics.inputTokens = Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0);
      metrics.outputTokens = Number(usage.output_tokens ?? 0);
      if (msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype !== "success")) error = `claude finished with ${String(msg.subtype)}: ${narrative.slice(0, 300)}`;
    }
  }
  return { narrative, toolCalls, result, intents, explored, metrics, ...(sessionId ? { sessionId } : {}), ...(error ? { error } : {}), ...(session ? { session } : {}) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface AgentOptions {
  question: string;
  /** Directory of the Claude Code plugin (clients/claude-code after bundling). */
  pluginDir: string;
  /** The pack causeline-mcp should serve (the prepared eval workspace). */
  packDir: string;
  /** Toolbox binary for causeline-mcp to start. */
  toolbox?: string;
  /** Run with --bare: reproducible, but needs ANTHROPIC_API_KEY and ignores your own plugins and settings. */
  bare: boolean;
  model?: string;
  /** Continue this earlier session (a conversation over several messages). */
  resume?: string;
  /** Extra environment for causeline-mcp. */
  env?: Record<string, string>;
  maxTurns: number;
  timeoutMs: number;
}

/** MCP tools of the plugin's server, as Claude Code names them: mcp__plugin_<plugin>_<server>__<tool>. */
export const PLUGIN_TOOLS = ["get_intent", "set_intent", "run_intent", "recall", "start_over", "check_connection", "list_playbooks", "run_playbook", "validate_pack", "generate_tools", "check_data", "analyze_seasonality", "route", "scan_kpis", "build_status", "connect_files", "connect_bigquery", "describe_data", "test_fact", "save_pack", "play_back", "reconcile_metric", "add_incident", "verify_expert", "propose_checks", "confirm_number", "signoff_status", "run_checks", "open_signoff", "accept_sample", "explore", "list_projects", "create_project", "open_project", "project_summary", "open_project_page", "check_setup", "get_guide", "setup_card", "save_setup_card", "cost_limit", "access_help", "discover_for_kpi", "sign_in"].map((t) => `mcp__plugin_causeline_causeline-mcp__${t}`);

const quote = (arg: string) => (/^[\w./:=@%+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/** Ask Claude Code the case's question, with only the plugin's tools pre-approved, and score what it says. */
export async function runClaudeCode(o: AgentOptions): Promise<AgentRun> {
  const args = [
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--plugin-dir", o.pluginDir,
    "--max-turns", String(o.maxTurns),
    "--allowedTools", ["Skill", ...PLUGIN_TOOLS].join(","),
  ];
  if (o.bare) args.unshift("--bare");
  if (o.model) args.push("--model", o.model);
  if (o.resume) args.push("--resume", o.resume);

  const env = { ...process.env, CAUSELINE_PACK: o.packDir, ...(o.toolbox ? { CAUSELINE_TOOLBOX: o.toolbox } : {}), ...(o.env ?? {}) };
  // on Windows `claude` is an npm .cmd shim, which can only be spawned through a shell
  const win = process.platform === "win32";
  const child = win ? spawn(["claude", ...args.map(quote)].join(" "), { env, shell: true, cwd: o.packDir, stdio: ["pipe", "pipe", "pipe"] }) : spawn("claude", args, { env, cwd: o.packDir, stdio: ["pipe", "pipe", "pipe"] });

  // the question goes in on stdin: a long, multi-line briefing does not survive a shell command line
  child.stdin!.end(o.question);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const timer = setTimeout(() => child.kill(), o.timeoutMs);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", resolve);
  });
  clearTimeout(timer);

  const run = parseStream(out.split(/\r?\n/).filter(Boolean));
  if (!run.narrative && !run.error) run.error = `claude produced no result (exit ${code}): ${err.trim().slice(0, 400)}`;
  return run;
}

// --- Codex -------------------------------------------------------------------------------------------------------------

/** Turn Codex's `exec --json` events into the same evidence: each finished MCP tool call becomes a tool use and its result. */
export function parseCodexStream(lines: string[]): AgentRun {
  const synthetic: string[] = [];
  let narrative = "";
  let threadId: string | undefined;
  let error: string | undefined;
  const metrics: AgentMetrics = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
  for (const line of lines) {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "thread.started") threadId = ev.thread_id;
    const item = ev.item;
    if (ev.type === "item.completed" && item?.type === "agent_message") narrative = String(item.text ?? "");
    if (ev.type === "item.completed" && item?.type === "mcp_tool_call") {
      const id = String(item.id);
      const text = item.error ? `ERROR: ${item.error.message ?? JSON.stringify(item.error)}` : textOf(item.result?.content);
      synthetic.push(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: item.tool, input: item.arguments ?? {} }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } }),
      );
    }
    if (ev.type === "turn.completed") {
      metrics.turns += 1;
      metrics.inputTokens += Number(ev.usage?.input_tokens ?? 0);
      metrics.outputTokens += Number(ev.usage?.output_tokens ?? 0);
    }
    if (ev.type === "turn.failed") error = `codex turn failed: ${String(ev.error?.message ?? "").slice(0, 300)}`;
  }
  const run = parseStream(synthetic);
  return { ...run, narrative, metrics, ...(threadId ? { sessionId: threadId } : {}), ...(error ? { error } : {}) };
}

export interface CodexOptions {
  question: string;
  /** Where Codex works from. */
  workDir: string;
  /** A Codex home that holds the sign-in and has Causeline installed (`causeline init --client codex`). */
  codexHome: string;
  /** A model the signed-in account can use (`codex debug models` lists them). */
  model: string;
  /** Continue this earlier thread. */
  resume?: string;
  /** Extra environment for the Causeline server (set through Codex's own config, since Codex passes a server only what is configured). */
  serverEnv?: Record<string, string>;
  timeoutMs: number;
}

/** Ask Codex a question with Causeline installed, approving Causeline's tools (non-interactive Codex refuses a tool that writes otherwise). */
export async function runCodex(o: CodexOptions): Promise<AgentRun> {
  const config = [
    `mcp_servers.causeline.default_tools_approval_mode="approve"`,
    ...Object.entries(o.serverEnv ?? {}).map(([k, v]) => `mcp_servers.causeline.env.${k}=${JSON.stringify(v)}`),
  ];
  const args = ["exec", ...(o.resume ? ["resume", o.resume] : []), "--json", "--skip-git-repo-check", "-m", o.model, ...(o.resume ? [] : ["-s", "read-only"]), ...config.flatMap((c) => ["-c", c]), "-"];
  const env = { ...process.env, CODEX_HOME: o.codexHome };
  const win = process.platform === "win32";
  const child = win ? spawn(["codex", ...args.map(quote)].join(" "), { env, shell: true, cwd: o.workDir, stdio: ["pipe", "pipe", "pipe"] }) : spawn("codex", args, { env, cwd: o.workDir, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.end(o.question);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const started = Date.now();
  const timer = setTimeout(() => child.kill(), o.timeoutMs);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", resolve);
  });
  clearTimeout(timer);
  const run = parseCodexStream(out.split(/\r?\n/).filter(Boolean));
  run.metrics.ms = Date.now() - started;
  if (!run.narrative && !run.error) run.error = `codex produced no answer (exit ${code}): ${err.trim().split("\n").filter((l) => !/WARNING|ERROR codex_/.test(l)).join(" ").slice(0, 400)}`;
  return run;
}
