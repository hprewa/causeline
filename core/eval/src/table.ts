import type { Score } from "./score.js";

export interface AgentMetrics {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
}

export interface CaseOutcome {
  id: string;
  runner: Score | { error: string };
  runnerMs: number;
  steps: number;
  agent?: (Score & { metrics: AgentMetrics; narrative?: string }) | { error: string };
}

const isScore = (s: unknown): s is Score => !!s && typeof s === "object" && "checks" in s;

const mark = (s: CaseOutcome["runner"] | CaseOutcome["agent"] | undefined): string => {
  if (!s) return "-";
  if (!isScore(s)) return "ERROR";
  return s.pass ? "pass" : "FAIL";
};

/** One table for a whole eval run, plus the failing checks underneath. */
export function renderTable(outcomes: CaseOutcome[], withAgent: boolean): string {
  const header = ["case", "runner", "steps", "ms", ...(withAgent ? ["agent", "turns", "tokens", "cost $", "agent s"] : [])];
  const rows = outcomes.map((o) => {
    const a = o.agent && isScore(o.agent) ? o.agent.metrics : undefined;
    return [
      o.id,
      mark(o.runner),
      String(o.steps),
      String(o.runnerMs),
      ...(withAgent ? [mark(o.agent), a ? String(a.turns) : "-", a ? String(a.inputTokens + a.outputTokens) : "-", a ? a.costUsd.toFixed(3) : "-", a ? (a.ms / 1000).toFixed(1) : "-"] : []),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];

  const passed = outcomes.filter((o) => isScore(o.runner) && o.runner.pass).length;
  out.push("", `runner score: ${passed}/${outcomes.length}`);
  if (withAgent) {
    const ran = outcomes.filter((o) => o.agent);
    out.push(`agent score:  ${ran.filter((o) => isScore(o.agent) && o.agent.pass).length}/${ran.length}`);
  }

  for (const o of outcomes) {
    for (const [level, s] of [["runner", o.runner], ["agent", o.agent]] as const) {
      if (!s) continue;
      if (!isScore(s)) out.push("", `${o.id} [${level}] ERROR: ${s.error}`);
      else for (const c of s.checks.filter((x) => !x.ok)) out.push("", `${o.id} [${level}] ${c.name}: ${c.detail ?? "failed"}`);
    }
  }
  return out.join("\n");
}
