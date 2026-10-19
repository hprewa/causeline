import { z } from "zod";

/**
 * tools.meta.yaml: what each generated tool is, so the runner finds a tool by what it answers
 * (a metric split by a concept, with given filters) and never by its name. Generated with the tools;
 * Toolbox itself rejects unknown fields, so this lives in a sidecar file outside its config folder.
 */
const base = { description: z.string().optional() };

export const ToolMeta = z.discriminatedUnion("kind", [
  /** A metric split by one concept, current vs baseline window. `filters` are the other concepts it can optionally be confined to. */
  z.object({ kind: z.literal("slice"), metric: z.string(), by: z.string(), filters: z.array(z.string()).default([]), ...base }),
  /**
   * A metric by time bucket, with each bucket's position in the cycles. One tool serves every time level in `levels`
   * (the level is a value passed as `aggregation`) and can optionally be confined to any of the concepts in `filters`.
   */
  z.object({ kind: z.literal("series"), metric: z.string(), levels: z.array(z.string()).min(1), filters: z.array(z.string()).default([]), ...base }),
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

// --- tool references: a tool name, plus values that are always passed to it ---------------------------

/**
 * A tool reference names a tool and the fixed values every call to it carries (the time level a series tool
 * is asked for). The text form is `name?key=value`, so the runner can treat it as the tool's name; whatever
 * executes the tool splits it with `parseToolRef` and sends the bound values as parameters.
 */
export function toolRef(name: string, bound: Record<string, string> = {}): string {
  const pairs = Object.entries(bound);
  return pairs.length === 0 ? name : `${name}?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
}

export function parseToolRef(ref: string): { name: string; bound: Record<string, string> } {
  const i = ref.indexOf("?");
  if (i < 0) return { name: ref, bound: {} };
  const bound: Record<string, string> = {};
  for (const pair of ref.slice(i + 1).split("&")) {
    const [k, v = ""] = pair.split("=");
    bound[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { name: ref.slice(0, i), bound };
}

// --- lookup: find a tool by what it answers -------------------------------------------------------

const covers = (supported: string[], wanted: string[]) => wanted.every((w) => supported.includes(w));

function find<K extends ToolMeta["kind"]>(meta: ToolsMeta, kind: K, pred: (m: Extract<ToolMeta, { kind: K }>) => boolean): string | undefined {
  for (const [name, m] of Object.entries(meta.tools)) if (m.kind === kind && pred(m as Extract<ToolMeta, { kind: K }>)) return name;
  return undefined;
}

/** The tool giving `metric` split by `by`, able to confine the rows to each of these concepts. */
export const findSlice = (meta: ToolsMeta, metric: string, by: string, filters: string[] = []) => find(meta, "slice", (m) => m.metric === metric && m.by === by && !filters.includes(by) && covers(m.filters, filters));
/** A reference to the tool giving `metric` by time bucket at `level`, able to confine the rows to each of these concepts. */
export function findSeries(meta: ToolsMeta, metric: string, level: string, filters: string[] = []): string | undefined {
  const name = find(meta, "series", (m) => m.metric === metric && m.levels.includes(level) && covers(m.filters, filters));
  return name === undefined ? undefined : toolRef(name, { aggregation: level });
}
export const findExtent = (meta: ToolsMeta, metric: string) => find(meta, "extent", (m) => m.metric === metric);
export const findProfile = (meta: ToolsMeta, metric: string, cycle: string) => find(meta, "seasonal_profile", (m) => m.metric === metric && m.cycle === cycle);
export const findEvidence = (meta: ToolsMeta, evidence: string) => find(meta, "evidence", (m) => m.evidence === evidence);
export const findCheck = (meta: ToolsMeta, check: string, opts: { fact?: string; metric?: string; arg?: string } = {}) =>
  find(meta, "check", (m) => m.check === check && m.fact === opts.fact && m.metric === opts.metric && m.arg === opts.arg);
