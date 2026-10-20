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
  return { narrative, toolCalls, result, intents, metrics, ...(sessionId ? { sessionId } : {}), ...(error ? { error } : {}), ...(session ? { session } : {}) };
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
export const PLUGIN_TOOLS = ["get_intent", "set_intent", "run_intent", "recall", "start_over", "check_connection", "list_playbooks", "run_playbook", "validate_pack", "generate_tools", "check_data", "analyze_seasonality", "route", "scan_kpis", "build_status", "connect_files", "connect_bigquery", "describe_data", "test_fact", "save_pack", "play_back", "reconcile_metric", "add_incident", "verify_expert", "propose_checks", "confirm_number", "signoff_status", "run_checks", "open_signoff"].map((t) => `mcp__plugin_causeline_causeline-mcp__${t}`);

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
