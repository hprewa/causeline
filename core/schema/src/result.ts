import { z } from "zod";

export const MetricKind = z.enum(["ratio", "sum", "product"]);
export type MetricKind = z.infer<typeof MetricKind>;

export const Headline = z.object({
  metric: z.string().min(1),
  /** How the metric is built. For a sum or a product the baseline is the average per baseline period. */
  kind: MetricKind.optional(),
  /**
   * How to read the figures. `fraction`: value, baseline and change are fractions (0.01 is one
   * percentage point), as for a rate. `number`: they are in the metric's own units, as for a total
   * or an average (a handle time in seconds is a ratio, but not a fraction).
   */
  format: z.enum(["fraction", "number"]).optional(),
  value: z.number(),
  baseline: z.number(),
  change: z.number(),
  /**
   * The pooled average of the baseline periods, kept for transparency when `baseline` is the
   * seasonally expected value (what this period should have been, given where it falls in each cycle).
   */
  baseline_naive: z.number().optional(),
  /**
   * For `number` figures: the change as a share of the baseline (0.043 is 4.3%), so a reader can
   * quote it instead of computing it. Absent for a `fraction`, where the change is in points.
   */
  relative_change: z.number().nullable().optional(),
  /** How far the value is from the baseline in standard errors, and whether that clears the pack's threshold. */
  z: z.number().optional(),
  significant: z.boolean().optional(),
});
export type Headline = z.infer<typeof Headline>;

export const Finding = z.object({
  rank: z.number().int().positive(),
  dimension: z.string().min(1),
  value: z.string().min(1),
  impact: z.number(),
  evidence: z.array(z.string()).default([]),
  /** Nodes this finding is confined to, as {level: node}, when a dimension value is bad only inside one node. */
  scope: z.record(z.string(), z.string()).optional(),
  effect: z.enum(["rate", "mix"]).optional(),
  /** `contributor`: reported because it carries a large and unusual part of the change although no single node dominated; absent for a culprit the drill followed. */
  role: z.enum(["contributor"]).optional(),
  persistence: z.enum(["persistent", "single_slot"]).optional(),
  /** The metric this finding is about: the drilled driver when the headline metric is a product. */
  metric: z.string().min(1).optional(),
});
export type Finding = z.infer<typeof Finding>;

export const StepLog = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  rows: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
});
export type StepLog = z.infer<typeof StepLog>;

/**
 * Records fetched from an evidence source about the culprits the drill found (an incident log, a scan
 * record). They support or contradict a finding; they are not a finding, and co-occurrence is not proof.
 */
export const Evidence = z.object({
  /** The playbook step that asked. */
  step: z.string().min(1),
  /** The evidence source, as named in data.yaml. */
  source: z.string().min(1),
  /** The concept values the records were asked about (one value per concept it is about). */
  about: z.record(z.string(), z.string()).default({}),
  window: z.object({ start: z.string(), end: z.string() }),
  /** Always "supporting": evidence never ranks as a finding. */
  kind: z.literal("supporting").default("supporting"),
  /** How many records matched (the sample below is capped). */
  rows: z.number().int().nonnegative(),
  sample: z.array(z.record(z.string(), z.unknown())).default([]),
  /** Set when the step could not ask (no culprit known for the concepts it is about). */
  skipped: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/** How a metric has moved period by period, each against its own like-for-like baseline. */
export const Trend = z.object({
  level: z.string(),
  buckets: z.array(z.object({ bucket: z.string(), value: z.number().nullable(), expected: z.number().nullable(), z: z.number().nullable(), significant: z.boolean(), /** Why it was not judged, when it was not. */ note: z.string().optional() })),
  /** First period of each run that left its baseline in one direction. */
  change_points: z.array(z.string()).default([]),
});
export type Trend = z.infer<typeof Trend>;

/** Two periods, or two nodes of one concept, side by side. */
export const Comparison = z.object({
  kind: z.enum(["periods", "nodes"]),
  metric: z.string(),
  concept: z.string().optional(),
  a: z.object({ label: z.string(), value: z.number(), volume: z.number() }),
  b: z.object({ label: z.string(), value: z.number(), volume: z.number() }),
  /** a minus b, in the metric's units (fractions for a rate). */
  difference: z.number(),
  relative_difference: z.number().nullable(),
  z: z.number(),
  significant: z.boolean(),
});
export type Comparison = z.infer<typeof Comparison>;

/** One node's part of the change, set against what that node usually contributes. */
export const Contribution = z.object({
  /** The concept (a hierarchy level or a flat dimension) and the value. */
  level: z.string().min(1),
  node: z.string().min(1),
  /** The node's part of the change in the KPI, in the KPI's own units (points of a rate, or amounts of a total). */
  contribution: z.number(),
  /** Its share of the whole change; null when the whole did not change. */
  share: z.number().nullable(),
  /** The node itself got better or worse; volume moved toward or away from a better or worse node. They add up to the contribution. */
  rate_effect: z.number().nullable(),
  mix_effect: z.number().nullable(),
  /** Rows in this period, and per period in the baseline, and the node's share of the baseline's rows (how big it is, to set its share of the change against). */
  volume: z.number(),
  baseline_volume: z.number(),
  baseline_share: z.number().default(0),
  /** The same contribution in up to eight earlier periods, each against its own baseline: how many, the median, and the range. Null without history. */
  history: z.object({ periods: z.number().int().nonnegative(), typical: z.number().nullable(), low: z.number().nullable(), high: z.number().nullable() }).nullable(),
  delta_vs_typical: z.number().nullable(),
  /** `new` (not a regular part of the data), `unusual` (outside its history), `usual` (it always contributes about this much: context, not the cause), `unknown` (too little history). */
  verdict: z.enum(["new", "unusual", "usual", "unknown"]),
});
export type Contribution = z.infer<typeof Contribution>;

/** How much of the change the reported contributors of one level account for, and what is left. */
export const Explained = z.object({ level: z.string().min(1), share: z.number(), unexplained: z.number() });
export type Explained = z.infer<typeof Explained>;

export const Decision = z.enum(["drill", "broad", "masked", "insufficient_volume"]);
export type Decision = z.infer<typeof Decision>;

export const PathNode = z.object({
  level: z.string().min(1),
  node: z.string().min(1),
  decision: Decision,
  hierarchy: z.string().optional(),
  parent: z.string().optional(),
  numbers: z.record(z.string(), z.unknown()).default({}),
});
export type PathNode = z.infer<typeof PathNode>;

/** A fact a step published, readable by name in later conditions: a number, a word, a yes/no, or nothing. */
export const FactValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FactValue = z.infer<typeof FactValue>;

/** One step the run executed: what it published, so the route taken through the playbook can be audited. */
export const TraceEntry = z.object({
  step: z.string().min(1),
  compute: z.string().min(1),
  facts: z.record(z.string(), FactValue).default({}),
  /** The rule that sent the run on from this step, and why (absent when the run simply went to the next step). */
  rule: z.string().optional(),
  because: z.string().optional(),
  /** Rules of this step that did not fire. */
  skipped: z.array(z.string()).default([]),
});
export type TraceEntry = z.infer<typeof TraceEntry>;

export const MaskingFlagType = z.enum(["offsetting", "dispersion", "mix_vs_rate", "small_cells"]);
export type MaskingFlagType = z.infer<typeof MaskingFlagType>;

export const MaskingFlag = z.object({
  level: z.string().min(1),
  node: z.string().optional(),
  type: MaskingFlagType,
  detail: z.string().optional(),
});
export type MaskingFlag = z.infer<typeof MaskingFlag>;

/** Carries attribution through to any front-end rendering result.json. */
export const Generator = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  url: z.string().url(),
});
export type Generator = z.infer<typeof Generator>;

/** One driver of a product metric, and how much of the product's change it carries. */
export const Driver = z.object({
  metric: z.string().min(1),
  value: z.number(),
  baseline: z.number(),
  change: z.number(),
  /** Share of the product's (log) change; null when the product did not change. */
  share: z.number().nullable(),
  significant: z.boolean(),
});
export type Driver = z.infer<typeof Driver>;

/** What the run did about repeating patterns. */
export const SeasonalityNote = z.object({
  /** `applied`: like-for-like baselines were used. `none_declared`: the ontology says there is no seasonality. */
  status: z.enum(["applied", "none_declared"]),
  cycles: z.array(z.string()).default([]),
  calendar: z.array(z.string()).default([]),
  /** `like_for_like`: baseline periods share the period's calendar flags. `pooled`: no comparable periods were found. */
  baseline: z.enum(["like_for_like", "pooled"]),
  /** Things a reader should know: a bucket with no comparable baseline, a flagged day that was not judged. */
  notes: z.array(z.string()).default([]),
});
export type SeasonalityNote = z.infer<typeof SeasonalityNote>;

export const Status = z.enum(["complete", "stopped", "error"]);
export type Status = z.infer<typeof Status>;

/** What a run cost on a database that bills by data read (BigQuery). Absent on a database that does not. */
export const Cost = z.object({
  queries: z.number().int().nonnegative(),
  bytes_scanned: z.number().nonnegative(),
  /** An estimate at on-demand list price; the first terabyte each month is free. */
  estimated_usd: z.number().nonnegative(),
  /** The most one run may read; null when there is no limit. */
  budget_bytes: z.number().nonnegative().nullable(),
});
export type Cost = z.infer<typeof Cost>;

export const Result = z.object({
  playbook: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  status: Status,
  /** Time window (data timestamps) the drill localised to. */
  window: z.object({ start: z.string(), end: z.string() }).optional(),
  /** Bucket where the change starts, from the trend at the period's own level. */
  onset: z.string().nullable().optional(),
  headline: Headline.nullable(),
  seasonality: SeasonalityNote.optional(),
  /** From the trend template. */
  trend: Trend.optional(),
  /** From the compare template. */
  comparison: Comparison.optional(),
  /** Present for product metrics: the driver split. */
  drivers: z.array(Driver).optional(),
  /** The driver the run went on to drill, or null when none dominated. */
  drilled_driver: z.string().nullable().optional(),
  findings: z.array(Finding).default([]),
  /** Who contributed how much to the change, judged against history. Deterministic; not a finding. */
  contributions: z.array(Contribution).default([]),
  explained: Explained.optional(),
  /** Supporting records from evidence sources, in the order they were asked. */
  evidence: z.array(Evidence).default([]),
  /** Ordered nodes visited during the guided drill, with the decision and numbers at each step. */
  path: z.array(PathNode).default([]),
  /** Every step run in order, with the facts it published and the rule that chose the next one. */
  trace: z.array(TraceEntry).default([]),
  masking_flags: z.array(MaskingFlag).default([]),
  steps: z.array(StepLog).default([]),
  stopped_reason: z.string().nullable().default(null),
  /** Human-readable specifics for stopped_reason, e.g. which nodes had missing data. */
  stopped_detail: z.string().nullable().default(null),
  /** Data read by the run's queries, when the database bills for it. */
  cost: Cost.optional(),
  /** Filled in by the LLM after the run; null until then. */
  narrative: z.string().nullable().default(null),
  generator: Generator,
});
export type Result = z.infer<typeof Result>;
