import type { FactValue } from "@causeline/schema";
import type { RunContext } from "./context.js";

/** What the run held before a step, so the step's own contribution can be told from what was already there. */
export interface Snapshot {
  paths: number;
  drafts: number;
  flags: number;
  evidence: number;
}

export const snapshotOf = (ctx: RunContext): Snapshot => ({ paths: ctx.path.length, drafts: ctx.drafts.length, flags: ctx.flags.length, evidence: ctx.evidence.length });

type Facts = Record<string, FactValue>;

/**
 * The facts each kind of step publishes, by the step's compute name. Conditions in a playbook may read only these (as `<step>.<name>`),
 * so the list is also what a playbook is checked against when it is loaded.
 */
export const FACTS: Record<string, string[]> = {
  coverage_and_counts: ["stopped"],
  change_vs_baseline: ["significant", "direction", "change", "z"],
  guided_drill: ["found", "decision", "flags"],
  rank_dimensions: ["found", "flags"],
  persistence: ["persistent", "single_slot"],
  contributions: ["count", "unusual"],
  contributors: ["found"],
  evidence: ["records"],
  handoff: ["count", "significant"],
  recovery: ["recovered", "ongoing"],
  trend: ["change_points"],
  compare: ["significant"],
};

function factsOf(ctx: RunContext, compute: string, before: Snapshot): Facts {
  const found = ctx.drafts.length - before.drafts;
  const flags = ctx.flags.length - before.flags;
  switch (compute) {
    case "coverage_and_counts":
      return { stopped: !!ctx.stop };
    case "change_vs_baseline": {
      const h = ctx.headline;
      return h ? { significant: !!h.significant, direction: h.change > 0 ? "up" : h.change < 0 ? "down" : "flat", change: h.change, z: h.z ?? null } : {};
    }
    case "guided_drill":
      return { found, decision: ctx.path.slice(before.paths)[0]?.decision ?? null, flags };
    case "rank_dimensions":
      return { found, flags };
    case "persistence":
      return { persistent: ctx.drafts.filter((d) => d.persistence === "persistent").length, single_slot: ctx.drafts.filter((d) => d.persistence === "single_slot").length };
    case "contributions":
      return { count: ctx.contributions.length, unusual: ctx.contributions.filter((c) => c.verdict === "unusual" || c.verdict === "new").length };
    case "contributors":
      return { found };
    case "recovery":
      return { recovered: ctx.drafts.filter((d) => d.after?.status === "recovered").length, ongoing: ctx.drafts.filter((d) => d.after?.status === "ongoing").length };
    case "handoff":
      return { count: ctx.handoffs.length, significant: ctx.handoffs.filter((h) => h.headline?.significant).length };
    case "evidence":
      return { records: ctx.evidence.slice(before.evidence).reduce((a, e) => a + e.rows, 0) };
    case "trend":
      return { change_points: ctx.trend?.change_points.length ?? 0 };
    case "compare":
      return { significant: ctx.comparison?.significant ?? null };
    default:
      return {};
  }
}

/** Record what a step published, under `<step>.<name>`, and add it to the trace. */
export function publishFacts(ctx: RunContext, stepId: string, compute: string, before: Snapshot): void {
  const facts = factsOf(ctx, compute, before);
  for (const [name, value] of Object.entries(facts)) ctx.facts[`${stepId}.${name}`] = value;
  ctx.trace.push({ step: stepId, compute, facts, skipped: [], notes: ctx.notes.splice(0) });
}
