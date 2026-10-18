import { z } from "zod";

/**
 * Time levels the core understands without any pack telling it anything. A pack can still name a
 * level the core has never heard of (a half-hour slot, a part of the day); its SQL then lives in the
 * pack's data.yaml (`time_levels`), never here: the ontology is vocabulary only.
 */
export const BUILTIN_TIME_LEVELS = [
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
] as const;

/**
 * SQL for each built-in level, per dialect. `%COL%` is substituted by the
 * generator (sprint 2) with the ontology's `time.column`. SQLite is the
 * only dialect sprint 1 needs; BigQuery/Snowflake are explicitly post-v1
 * per the build spec.
 */
export const BUILTIN_TIME_LEVEL_SQL: Record<string, Record<(typeof BUILTIN_TIME_LEVELS)[number], string>> = {
  sqlite: {
    year: "strftime('%Y', %COL%)",
    quarter:
      "strftime('%Y', %COL%) || '-Q' || ((CAST(strftime('%m', %COL%) AS INTEGER) - 1) / 3 + 1)",
    month: "strftime('%Y-%m', %COL%)",
    week: "strftime('%Y-W%W', %COL%)",
    day: "strftime('%Y-%m-%d', %COL%)",
    hour: "strftime('%Y-%m-%d %H', %COL%)",
  },
};

/**
 * Positions within a repeating pattern ("cycles") the core understands without help. A bucket's
 * *slot* is where it falls in the cycle (a Wednesday, the 12:00 hour). Built-in SQL per dialect,
 * as for time levels. `instance` identifies one occurrence of a slot (a particular Wednesday
 * date), so the analysis can count repetitions; `cycleDays` is the length of the cycle.
 */
export const BUILTIN_SLOTS = ["weekday", "hour_of_day", "half_hour_of_day", "day_of_month", "month_of_year"] as const;
export type BuiltinSlot = (typeof BUILTIN_SLOTS)[number];

const HALF_HOUR = "strftime('%H', %COL%) || ':' || CASE WHEN CAST(strftime('%M', %COL%) AS INTEGER) < 30 THEN '00' ELSE '30' END";

export const BUILTIN_SLOT_SQL: Record<string, Record<BuiltinSlot, { slot: string; instance: string; cycleDays: number }>> = {
  sqlite: {
    weekday: { slot: "strftime('%w', %COL%)", instance: "date(%COL%)", cycleDays: 7 },
    hour_of_day: { slot: "strftime('%H', %COL%)", instance: "strftime('%Y-%m-%d %H', %COL%)", cycleDays: 1 },
    half_hour_of_day: { slot: HALF_HOUR, instance: `strftime('%Y-%m-%d', %COL%) || ' ' || ${HALF_HOUR}`, cycleDays: 1 },
    day_of_month: { slot: "strftime('%d', %COL%)", instance: "date(%COL%)", cycleDays: 30.4 },
    month_of_year: { slot: "strftime('%m', %COL%)", instance: "strftime('%Y-%m', %COL%)", cycleDays: 365.25 },
  },
};

/** Names are interpolated into generated SQL as quoted identifiers, so keep them plain. */
export const Identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a plain identifier (letters, digits, underscore)");

/** A time level is just a name. Built-in names (week, day, ...) need nothing else; others are defined in data.yaml. */
export const TimeLevel = Identifier;
export type TimeLevel = z.infer<typeof TimeLevel>;

/**
 * Seasonality is declared, never assumed away. Either the patterns the data follows (cycles: a
 * position within a week or a day, by name; calendar: names of two-valued flags such as a holiday), or
 * an explicit `none` once onboarding has looked and found nothing. A pack that has not looked cannot
 * validate. A cycle name is either a built-in (weekday, hour_of_day, ...) or defined in data.yaml.
 */
export const Seasonality = z.union([
  z.literal("none"),
  z
    .object({
      cycles: z.array(Identifier).default([]),
      calendar: z.array(Identifier).default([]),
    })
    .refine((s) => s.cycles.length + s.calendar.length > 0, { message: "list at least one cycle or calendar flag, or write seasonality: none" })
    .refine((s) => new Set([...s.cycles, ...s.calendar]).size === s.cycles.length + s.calendar.length, { message: "cycle and calendar names must be unique" }),
]);
export type Seasonality = z.infer<typeof Seasonality>;

export const Time = z.object({
  /** Coarse to fine. */
  levels: z
    .array(TimeLevel)
    .min(1)
    .refine((l) => new Set(l).size === l.length, { message: "time.levels names must be unique" }),
  seasonality: Seasonality,
});
export type Time = z.infer<typeof Time>;

const HierarchyLevels = z
  .array(Identifier)
  .min(1)
  .refine((levels) => new Set(levels).size === levels.length, {
    message: "hierarchy levels must be unique",
  });

/** Any number of hierarchies, any names, each an ordered coarse-to-fine level list. */
export const Hierarchies = z.record(Identifier, HierarchyLevels);
export type Hierarchies = z.infer<typeof Hierarchies>;

export const Direction = z.enum(["higher_is_better", "lower_is_better"]);
export type Direction = z.infer<typeof Direction>;

/** How a KPI relates to the KPIs below it in a KPI tree. Declared now, used by a later sprint. */
export const KpiRelation = z.enum(["sum", "product", "both_required", "driver"]);

const MetricBase = {
  direction: Direction,
  min_volume: z.number().int().nonnegative().default(0),
  /** One plain sentence: what the number means. */
  description: z.string().optional(),
  /** Plain words people use for it, so a question can be matched to the KPI. */
  synonyms: z.array(z.string().min(1)).optional(),
  /** KPI tree: the KPIs this one is made of or driven by, and how. */
  children: z.array(z.string().min(1)).optional(),
  relation: KpiRelation.optional(),
};

/** A ratio of two things the data definition counts (numerator over denominator). Its formula is in data.yaml. */
const RatioMetric = z.object({ type: z.literal("ratio"), ...MetricBase });

/** A total of something additive. Its formula is in data.yaml. */
const SumMetric = z.object({ type: z.literal("sum"), ...MetricBase });

const ProductMetric = z.object({
  type: z.literal("product"),
  /**
   * Names of other metrics (sum or ratio) whose values multiply to this one. The change is split
   * across them first (log method), then the biggest driver is drilled as a metric in its own right.
   */
  drivers: z.array(z.string().min(1)).min(2),
  ...MetricBase,
});

export const Metric = z.discriminatedUnion("type", [RatioMetric, SumMetric, ProductMetric]);
export type Metric = z.infer<typeof Metric>;

export const Metrics = z
  .record(z.string().min(1), Metric)
  .refine((m) => Object.keys(m).length > 0, { message: "ontology must declare at least one metric" });
export type Metrics = z.infer<typeof Metrics>;

/** Optional pack-level tuning of the runner's decision thresholds. */
export const Thresholds = z
  .object({
    /** Share of the change one child must explain to be drilled into. */
    drill_share: z.number().positive().max(1),
    /** Gross child movement / net change above which children are cancelling out. */
    offset_ratio: z.number().positive(),
    /** Share of the net change attributable to volume mix above which the level is mix-masked. */
    mix_share: z.number().positive(),
    /** Current rows / baseline average rows below which a node counts as missing data. */
    coverage_ratio: z.number().positive().max(1),
    /** z-score above which a parent's change counts as real (else it "looks flat"). */
    parent_z: z.number().positive(),
    /** z-score a child's rate change needs to be a candidate culprit. */
    child_z: z.number().positive(),
    /** z-score for a trend bucket to count as part of the change's onset. */
    onset_z: z.number().positive(),
    /** Seasonality analysis: p-value a cycle must beat to count as statistically real. */
    season_p: z.number().positive().max(1),
    /** Seasonality analysis: smallest peak-to-trough swing, as a share of the overall level, worth adjusting for. */
    season_amplitude: z.number().positive(),
    /** Seasonality analysis: repetitions of a cycle the data must hold before it can be assessed. */
    season_min_repeats: z.number().int().positive(),
  })
  .partial();
export type Thresholds = z.infer<typeof Thresholds>;

/**
 * The business vocabulary and nothing else: what the hierarchies, time levels, flat dimensions and
 * KPIs are called, and how they relate. No tables, columns or SQL (those are in data.yaml).
 */
export const Ontology = z.object({
  time: Time,
  hierarchies: Hierarchies,
  /** Flat dimensions: no parent-child relationship between values. */
  dimensions: z.array(Identifier).default([]),
  metrics: Metrics,
  thresholds: Thresholds.optional(),
});
export type Ontology = z.infer<typeof Ontology>;

/** Every concept a question can be split or filtered by: hierarchy levels and flat dimensions. */
export function conceptsOf(ont: Pick<Ontology, "hierarchies" | "dimensions">): string[] {
  return [...new Set([...Object.values(ont.hierarchies).flat(), ...ont.dimensions])];
}
