import { z } from "zod";

/**
 * tools.meta.yaml: what each generated tool is, so the runner finds a tool by what it answers
 * (a metric split by a concept, with given filters) and never by its name. Generated with the tools;
 * Toolbox itself rejects unknown fields, so this lives in a sidecar file outside its config folder.
 */
const base = { description: z.string().optional() };

export const ToolMeta = z.discriminatedUnion("kind", [
  /** A metric split by one concept, current vs baseline window; optional filters by other concepts. */
  z.object({ kind: z.literal("slice"), metric: z.string(), by: z.string(), filters: z.array(z.string()).default([]), ...base }),
  /** A metric by time bucket (optionally confined to one node), with each bucket's position in the cycles. */
  z.object({ kind: z.literal("series"), metric: z.string(), level: z.string(), filters: z.array(z.string()).default([]), ...base }),
  /** Row count and time extent of the metric's fact. */
  z.object({ kind: z.literal("extent"), metric: z.string(), ...base }),
  /** Onboarding: a metric by position in a candidate cycle or calendar flag. */
  z.object({ kind: z.literal("seasonal_profile"), metric: z.string(), cycle: z.string(), ...base }),
  /** Onboarding: one structural check on a fact (parents, daily rows, nulls, level sizes) or a metric's value ranges. */
  z.object({ kind: z.literal("check"), check: z.enum(["parent", "level", "daily_rows", "nulls", "values"]), fact: z.string().optional(), metric: z.string().optional(), arg: z.string().optional(), ...base }),
  /** Records that explain or confirm a finding, filterable by the concepts they are about. */
  z.object({ kind: z.literal("evidence"), evidence: z.string(), about: z.array(z.string()), ...base }),
]);
export type ToolMeta = z.infer<typeof ToolMeta>;

export const ToolsMeta = z.object({ tools: z.record(z.string().min(1), ToolMeta) });
export type ToolsMeta = z.infer<typeof ToolsMeta>;

// --- lookup: find a tool by what it answers -------------------------------------------------------

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function find<K extends ToolMeta["kind"]>(meta: ToolsMeta, kind: K, pred: (m: Extract<ToolMeta, { kind: K }>) => boolean): string | undefined {
  for (const [name, m] of Object.entries(meta.tools)) if (m.kind === kind && pred(m as Extract<ToolMeta, { kind: K }>)) return name;
  return undefined;
}

/** The tool giving `metric` split by `by`, confined by exactly these filter concepts. */
export const findSlice = (meta: ToolsMeta, metric: string, by: string, filters: string[] = []) => find(meta, "slice", (m) => m.metric === metric && m.by === by && sameSet(m.filters, filters));
/** The tool giving `metric` by time bucket at `level`, confined by exactly these filter concepts. */
export const findSeries = (meta: ToolsMeta, metric: string, level: string, filters: string[] = []) => find(meta, "series", (m) => m.metric === metric && m.level === level && sameSet(m.filters, filters));
export const findExtent = (meta: ToolsMeta, metric: string) => find(meta, "extent", (m) => m.metric === metric);
export const findProfile = (meta: ToolsMeta, metric: string, cycle: string) => find(meta, "seasonal_profile", (m) => m.metric === metric && m.cycle === cycle);
export const findEvidence = (meta: ToolsMeta, evidence: string) => find(meta, "evidence", (m) => m.evidence === evidence);
export const findCheck = (meta: ToolsMeta, check: string, opts: { fact?: string; metric?: string; arg?: string } = {}) =>
  find(meta, "check", (m) => m.check === check && m.fact === opts.fact && m.metric === opts.metric && m.arg === opts.arg);
