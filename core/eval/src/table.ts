import type { Score } from "./score.js";

export interface AgentMetrics {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
}

/** The parts of a run's result that must be the same on every database, so two backends can be compared. */
export interface RunSummary {
  status: string;
  stopped_reason: string | null;
  headline: { value: number; baseline: number; change: number } | null;
  /** The top findings, as `dimension=value` with any scope, in rank order. */
  findings: string[];
  masking_flags: string[];
  /** Queries and bytes read, on a database that bills by data read. */
  cost?: { queries: number; bytes_scanned: number; estimated_usd: number };
}

export interface CaseOutcome {
  id: string;
  /** The case's `gap` marker: why it is expected to fail today. */
  gap?: string;
  /** What the run found, for comparing databases. */
  summary?: RunSummary;
  runner: Score | { error: string };
  runnerMs: number;
  steps: number;
  agent?: (Score & { metrics: AgentMetrics; narrative?: string }) | { error: string };
}

const isScore = (s: unknown): s is Score => !!s && typeof s === "object" && "checks" in s;

const mark = (s: CaseOutcome["runner"] | CaseOutcome["agent"] | undefined, gap?: string): string => {
  if (!s) return "-";
  if (!isScore(s)) return "ERROR";
  if (gap) return s.pass ? "GAP CLOSED" : "gap";
  return s.pass ? "pass" : "FAIL";
};

/** Did the runner side of a case do what was asked? A known gap is "ok" while it still fails, and not ok once it passes (remove the marker). */
export function runnerOk(o: CaseOutcome): boolean {
  if (!isScore(o.runner)) return false;
  return o.gap ? !o.runner.pass : o.runner.pass;
}

/** One table for a whole eval run, plus the failing checks underneath. */
export function renderTable(outcomes: CaseOutcome[], withAgent: boolean): string {
  const header = ["case", "runner", "steps", "ms", ...(withAgent ? ["agent", "turns", "tokens", "cost $", "agent s"] : [])];
  const rows = outcomes.map((o) => {
    const a = o.agent && isScore(o.agent) ? o.agent.metrics : undefined;
    return [
      o.id,
      mark(o.runner, o.gap),
      String(o.steps),
      String(o.runnerMs),
      ...(withAgent ? [mark(o.agent), a ? String(a.turns) : "-", a ? String(a.inputTokens + a.outputTokens) : "-", a ? a.costUsd.toFixed(3) : "-", a ? (a.ms / 1000).toFixed(1) : "-"] : []),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];

  const normal = outcomes.filter((o) => !o.gap);
  const gaps = outcomes.filter((o) => o.gap);
  const passed = normal.filter((o) => isScore(o.runner) && o.runner.pass).length;
  out.push("", `runner score: ${passed}/${normal.length}${gaps.length > 0 ? ` (and ${gaps.length} known gap${gaps.length === 1 ? "" : "s"}, ${gaps.filter((g) => isScore(g.runner) && !g.runner.pass).length} still open)` : ""}`);
  for (const g of gaps) out.push(`  gap ${g.id}: ${g.gap}${isScore(g.runner) && g.runner.pass ? "  <- it passes now: remove the gap marker" : ""}`);
  if (withAgent) {
    const ran = outcomes.filter((o) => o.agent);
    out.push(`agent score:  ${ran.filter((o) => isScore(o.agent) && o.agent.pass).length}/${ran.length}`);
  }

  for (const o of outcomes) {
    for (const [level, s] of [["runner", o.runner], ["agent", o.agent]] as const) {
      if (!s) continue;
      if (!isScore(s)) out.push("", `${o.id} [${level}] ERROR: ${s.error}`);
      else if (!(o.gap && level === "runner")) for (const c of s.checks.filter((x) => !x.ok)) out.push("", `${o.id} [${level}] ${c.name}: ${c.detail ?? "failed"}`);
    }
  }
  return out.join("\n");
}
