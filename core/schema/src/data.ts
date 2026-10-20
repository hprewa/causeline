import { z } from "zod";
import { Identifier } from "./ontology.js";

/**
 * data.yaml: the one file that knows about tables and SQL. Everything else (ontology, playbooks,
 * runner) speaks in concepts. Swapping the database means rewriting this file and nothing else.
 */

/** A SQL expression written as text; numbers are accepted for things like a denominator of 1. */
const Sql = z.union([z.string().min(1), z.number()]).transform((v) => String(v));

/** A cycle the core has no built-in for: where a timestamp falls in it, which occurrence it is, and how long it is. */
export const CustomSlot = z.object({
  expr: z.string().min(1),
  instance: z.string().min(1),
  cycle_days: z.number().positive(),
});
export type CustomSlot = z.infer<typeof CustomSlot>;

/**
 * One kind of event the metrics are counted over (an order, a visit), as one SELECT with a row per
 * event and every column named. Joins across as many tables as needed are written here, once.
 */
export const Fact = z.object({
  /** The SELECT. Its columns are used by name in `time`, `concepts`, `slots` and the metric formulas. */
  sql: z.string().min(1),
  /** The column holding the event's timestamp. */
  time: Identifier,
  /** Columns of the SELECT that carry a business concept (a hierarchy level or flat dimension), named as the concept. */
  concepts: z.array(Identifier).default([]),
  /** SQL for time levels the core has no built-in for (a part of the day), written over the SELECT's columns. */
  time_levels: z.record(Identifier, z.string().min(1)).default({}),
  /**
   * Cycles and calendar flags that are not built in. A flag may be a column name (`flag_name: column_name`)
   * or SQL; a custom cycle is `{expr, instance, cycle_days}`. Built-in cycles (weekday, hour_of_day, ...) need no entry.
   */
  slots: z.record(Identifier, z.union([z.string().min(1), CustomSlot])).default({}),
  /**
   * What one row of the SELECT stands for, as a column of a source table (for example the key of the table the SELECT is built on). When given, the sign-off checks that the SELECT has as many rows as that column has
   * distinct values, so a join that repeats rows cannot slip through. Optional: without it that check is skipped.
   */
  one_row_per: z.object({ table: z.string().min(1), column: z.string().min(1) }).optional(),
});
export type Fact = z.infer<typeof Fact>;

const RatioFormula = z.object({
  fact: z.string().min(1),
  numerator: Sql,
  denominator: Sql.default("1"),
});

const SumFormula = z.object({
  fact: z.string().min(1),
  /** The additive quantity, per row. */
  value: Sql,
});

/** How a metric from the ontology is calculated, over a fact's columns. Product metrics have no entry: their drivers do. */
export const MetricFormula = z.union([RatioFormula, SumFormula]);
export type MetricFormula = z.infer<typeof MetricFormula>;

/**
 * A source of records that explain or confirm a finding, from any table (an incident log, a scan
 * record). It is asked about the concepts it lists, and returns rows carrying those keys.
 */
export const EvidenceSource = z.object({
  description: z.string().optional(),
  sql: z.string().min(1),
  /** The column holding the record's timestamp (the window is applied to it). */
  time: Identifier,
  /**
   * For records that last a while (an outage from Monday to Thursday): the column holding when it ended.
   * A record then matches a window it overlaps, not only one it started in.
   */
  until: Identifier.optional(),
  /** Concepts the rows can be filtered by; each must be a column of the SELECT, named as the concept. */
  about: z.array(Identifier).min(1),
});
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** The SQL dialects the generator can write. */
export const DIALECTS = ["sqlite", "bigquery"] as const;
export type DialectName = (typeof DIALECTS)[number];

export const DataDefs = z.object({
  /** The Toolbox source the generated tools run against. */
  source: z.string().min(1),
  /** The SQL dialect of this file's SELECTs and of the source (default sqlite). Generated tools are written in it. */
  dialect: z.enum(DIALECTS).default("sqlite"),
  /**
   * What "today" means to a question. `today` is the real date; `data_end` is the day after the data's last day,
   * for data that stops at a fixed date (a sample, a historic extract), so "last week" means the last week it holds.
   */
  as_of: z.enum(["today", "data_end"]).default("today"),
  /**
   * The most one question may read from a metered database, in GB (BigQuery). A deep dive runs a few dozen queries over the
   * fact, so the right figure depends on how much the fact reads; the Builder works it out. The environment variable
   * CAUSELINE_BQ_BUDGET_GB overrides it, and 0 means no limit. Absent: the default.
   */
  budget_gb: z.number().min(0).optional(),
  facts: z.record(Identifier, Fact).refine((f) => Object.keys(f).length > 0, { message: "define at least one fact" }),
  metrics: z.record(z.string().min(1), MetricFormula).default({}),
  evidence: z.record(Identifier, EvidenceSource).default({}),
});
export type DataDefs = z.infer<typeof DataDefs>;

export const isRatioFormula = (f: MetricFormula): f is z.infer<typeof RatioFormula> => "numerator" in f;
