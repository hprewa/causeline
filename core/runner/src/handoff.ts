import type { Handoff } from "@causeline/schema";
import type { RunContext } from "./context.js";

/** How many KPIs deep a hand-off may go (a KPI handed over to may hand over once more, no further). */
export const MAX_HANDOFF_DEPTH = 2;
/** Parts analysed for one hand-off. */
const MAX_PARTS = 3;
/** Findings and contributions kept from each part (the part's own result is not embedded in full). */
const KEPT = 5;

/**
 * Analyse other KPIs on the same period and keep a short account of each. A KPI already being analysed higher up the chain is never
 * analysed again, and nothing happens when the chain is as long as it may be: the trace says so.
 */
export async function handOver(ctx: RunContext, metrics: string[], reason: string): Promise<void> {
  const note = (text: string) => void ctx.notes.push(text);
  if (!ctx.analyse) return note("hand-over not made: the chain of hand-offs is as long as it may be");
  for (const metric of metrics.slice(0, MAX_PARTS)) {
    if (!ctx.ontology.metrics[metric]) {
      note(`hand-over to "${metric}" not made: it is not a KPI of this pack`);
      continue;
    }
    if (metric === ctx.metric) continue;
    const r = await ctx.analyse(metric);
    const kept: Handoff = {
      metric,
      reason,
      status: r.status,
      stopped_reason: r.stopped_reason,
      headline: r.headline,
      findings: r.findings.slice(0, KEPT),
      contributions: r.contributions.slice(0, KEPT),
    };
    ctx.handoffs.push(kept);
  }
}

/** The step form: hand over to the KPI's own parts, as the ontology lists them in `children`. */
export async function handOverToParts(ctx: RunContext): Promise<void> {
  const parts = ctx.ontology.metrics[ctx.metric]?.children ?? [];
  await handOver(ctx, parts, `no part of the data explains the change in ${ctx.metric}; these are the KPIs it depends on`);
}
