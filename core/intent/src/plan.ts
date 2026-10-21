import { CORE_PLAYBOOK, effectiveExperts } from "@causeline/router";
import type { AgentDef, Ontology, ResolvedIntent, Rung } from "@causeline/schema";

export type RunPlan =
  | {
      kind: "run";
      playbook: string;
      expert: string;
      /** Where the expert stands on the ladder, and whether the numbers under it were only a plausible sample. */
      status: Rung;
      unconfirmed_numbers: boolean;
      inputs: Record<string, string | number>;
    }
  | { kind: "cannot"; reason: string };

/** Period labels of the data's top time level with the days each covers (as `IntentEnv.labels`). */
export type LabelSpans = { label: string; start: string; end: string }[];

const labelFor = (labels: LabelSpans, w: { start: string; end: string; label?: string }) => w.label ?? labels.find((l) => l.start === w.start && l.end === w.end)?.label;

/**
 * What to run for a resolved intent: the expert for the KPI and task (or the core template), and the inputs the
 * playbook takes. Nothing is decided here that the intent did not say: a window becomes dates (or the data's own
 * label when the person named one), filters become a scope, and an aggregation or baseline is passed as given.
 */
export function planRun(r: ResolvedIntent, opts: { ontology: Ontology; agents: AgentDef[]; labels: LabelSpans }): RunPlan {
  const expert = effectiveExperts(opts.ontology, opts.agents).find((a) => a.kpi === r.kpi && a.task === r.task);
  if (!expert) return { kind: "cannot", reason: `there is no way to ${r.task} ${r.kpi}` };
  const inputs: Record<string, string | number> = { metric: r.kpi };

  if (r.task === "compare") {
    if (!r.against) return { kind: "cannot", reason: "a comparison needs the other period" };
    const [a, b] = [labelFor(opts.labels, r.window), labelFor(opts.labels, r.against)];
    if (!a || !b) {
      const top = opts.ontology.time.levels[0];
      return { kind: "cannot", reason: `comparing two periods works on whole ${top}s of the data, and ${!a ? r.window.description : r.against.description} is not one. Ask for whole ${top}s, or look at each period on its own.` };
    }
    inputs.period = a;
    inputs.against = b;
  } else if (r.window.label) {
    inputs.period = r.window.label;
  } else {
    inputs.start_date = r.window.start;
    inputs.end_date = r.window.end;
  }
  if (r.aggregation) inputs.aggregation = r.aggregation;
  if (r.baseline !== undefined) inputs.baseline = r.baseline;
  if (Object.keys(r.filters).length > 0) inputs.scope = JSON.stringify(r.filters);
  return { kind: "run", playbook: expert.playbook ?? CORE_PLAYBOOK[r.task], expert: expert.name, status: expert.status, unconfirmed_numbers: expert.unconfirmed_numbers, inputs };
}
