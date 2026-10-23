import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexStream } from "../src/agent.js";

const ev = (o: unknown) => JSON.stringify(o);

test("Codex events become the same evidence as Claude Code's: tool calls with their answers, the last message, the thread to resume", () => {
  const run = parseCodexStream([
    ev({ type: "thread.started", thread_id: "t-1" }),
    ev({ type: "turn.started" }),
    ev({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "Looking." } }),
    ev({ type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "causeline", tool: "run_playbook", arguments: { name: "metric_change" }, result: null, error: null, status: "in_progress" } }),
    ev({ type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "causeline", tool: "run_playbook", arguments: { name: "metric_change" }, result: { content: [{ type: "text", text: JSON.stringify({ note: "no result here" }) }] }, error: null, status: "completed" } }),
    ev({ type: "item.completed", item: { id: "i2", type: "mcp_tool_call", server: "causeline", tool: "create_project", arguments: { name: "X" }, result: null, error: { message: "MCP tool call requires approval, but approval policy is never" }, status: "failed" } }),
    ev({ type: "item.completed", item: { id: "i3", type: "agent_message", text: "All done." } }),
    ev({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 7 } }),
  ]);
  assert.equal(run.narrative, "All done.");
  assert.equal(run.sessionId, "t-1");
  assert.deepEqual(run.toolCalls.map((t) => t.name), ["run_playbook", "create_project"]);
  assert.match(run.toolCalls[1].output ?? "", /requires approval/);
  assert.equal(run.metrics.inputTokens, 100);
  assert.equal(run.metrics.turns, 1);
  assert.equal(run.error, undefined);
});

test("a failed turn is an error with its reason", () => {
  const run = parseCodexStream([ev({ type: "turn.failed", error: { message: "The model is not supported" } })]);
  assert.match(run.error ?? "", /not supported/);
});
