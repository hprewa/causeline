import { z } from "zod";
import { Generator } from "./result.js";

/**
 * The Explorer answers questions no expert covers from a closed set of read operations over the project's own catalogue tools. An
 * exploration is the record of one such question: every step it took, in order, with what was asked in words, the rows it got and what
 * it read. It is always labelled exploratory: it is a fixed read of the data, not a checked expert, and it claims nothing about cause.
 */

/** Why a request was not carried out, in a form the person and the page can both show. */
export const Refusal = z.object({
  code: z.enum(["free_sql", "join", "cause", "change", "unknown_kpi", "unknown_concept", "unsupported", "budget", "other"]),
  reason: z.string().min(1),
  /** What can be done instead. */
  instead: z.string().min(1),
});
export type Refusal = z.infer<typeof Refusal>;

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ExploreStep = z.object({
  n: z.number().int().positive(),
  op: z.string().min(1),
  /** What was asked, in plain words. */
  asked: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  /** One plain sentence on what came back; the assistant quotes the rows, never computes from them. */
  says: z.string().default(""),
  columns: z.array(z.string()).default([]),
  rows: z.array(z.record(z.string(), Cell)).default([]),
  /** Rows the operation found before it kept the most useful ones. */
  rows_total: z.number().int().nonnegative().default(0),
  notes: z.array(z.string()).default([]),
  refusal: Refusal.optional(),
  queries: z.number().int().nonnegative().default(0),
  /** Data read, on a database that bills by data read. */
  bytes_scanned: z.number().nonnegative().optional(),
  ms: z.number().nonnegative().default(0),
});
export type ExploreStep = z.infer<typeof ExploreStep>;

export const Exploration = z.object({
  id: z.string().min(1),
  /** The question as the person asked it. */
  question: z.string().default(""),
  started: z.string(),
  label: z.literal("exploratory").default("exploratory"),
  /** The KPIs read, each with where it stands on the ladder when it was read ("not checked against your reports" for a draft). */
  kpis: z.array(z.object({ kpi: z.string(), rung: z.string() })).default([]),
  steps: z.array(ExploreStep).default([]),
  budget: z.object({ steps: z.number().int(), max_steps: z.number().int(), rows: z.number().int(), max_rows: z.number().int() }),
  /** Set when a budget ended the exploration. */
  stopped: z.object({ reason: z.string(), detail: z.string() }).nullable().default(null),
  generator: Generator.optional(),
});
export type Exploration = z.infer<typeof Exploration>;

/** What every answer from the Explorer says about itself. */
export const EXPLORATORY_SAYS = "This answer is exploratory: it comes from a fixed read of your data, not from a checked expert, and it makes no claim about cause.";
