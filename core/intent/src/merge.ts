import { Intent, IntentPatch } from "@causeline/schema";

/** Apply one message's patch to the active intent. Left out: unchanged. Null: cleared. A filter set to null is removed. */
export function mergeIntent(active: Intent, patch: IntentPatch): Intent {
  const next: Intent = { ...active, filters: { ...active.filters } };
  const set = <K extends "kpi" | "task" | "period" | "comparison" | "aggregation" | "baseline">(key: K) => {
    const v = patch[key];
    if (v === undefined) return;
    if (v === null) delete next[key];
    else (next as Record<string, unknown>)[key] = v;
  };
  for (const key of ["kpi", "task", "period", "comparison", "aggregation", "baseline"] as const) set(key);
  for (const [concept, value] of Object.entries(patch.filters ?? {})) {
    if (value === null) delete next.filters[concept];
    else next.filters[concept] = value;
  }
  return Intent.parse(next);
}
