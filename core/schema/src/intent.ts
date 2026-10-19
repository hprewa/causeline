import { z } from "zod";
import { Task } from "./agent.js";

/**
 * Intent: what a person wants to know, as a fixed structure. An agent fills it in from the conversation
 * (it understands words); deterministic code checks and resolves it (it never guesses). The period is data,
 * not text: "last 4 weeks" is `{kind: relative, unit: week, offset: 1, count: 4}`, and code turns it into dates.
 */

export const CALENDAR_UNITS = ["day", "week", "month", "quarter", "year"] as const;
export const CalendarUnit = z.enum(CALENDAR_UNITS);
export type CalendarUnit = z.infer<typeof CalendarUnit>;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date written YYYY-MM-DD");

export const PeriodSpec = z.discriminatedUnion("kind", [
  /** Exact dates, both included. "1 to 31 August 2026". */
  z.object({ kind: z.literal("range"), start: Day, end: Day }),
  /**
   * Whole calendar units back from now. `offset` is how many units back the span ends (0 = the current one,
   * so far; 1 = the last complete one), `count` how many units it covers. Yesterday: day, 1, 1. Last week: week, 1, 1.
   * Last 4 weeks: week, 1, 4. Last 30 days: day, 1, 30.
   */
  z.object({
    kind: z.literal("relative"),
    unit: CalendarUnit,
    offset: z.number().int().min(0).default(1),
    count: z.number().int().min(1).max(1000).default(1),
  }),
  /** The current unit so far: year to date, month to date. */
  z.object({ kind: z.literal("to_date"), unit: CalendarUnit }),
  /** From a date up to the latest complete day. "Since 1 August". */
  z.object({ kind: z.literal("since"), date: Day }),
  /** A named calendar unit: August, Q3, 2025. A missing year means the latest such unit that has begun. */
  z.object({
    kind: z.literal("calendar"),
    unit: z.enum(["month", "quarter", "year"]),
    index: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(1900).max(2200).optional(),
  }),
  /** A period label of the data's own top time level, as listed to the agent ("2026-W07"). */
  z.object({ kind: z.literal("label"), label: z.string().min(1) }),
]);
export type PeriodSpec = z.infer<typeof PeriodSpec>;

/** What the period is compared with, for a comparison. A bare word is accepted for the two common cases. */
export const ComparisonSpec = z.preprocess(
  (v) => (v === "previous" || v === "same_last_year" ? { kind: v } : v),
  z.discriminatedUnion("kind", [
    /** The period just before, as long as this one (the same unit before, for a whole month or quarter). */
    z.object({ kind: z.literal("previous") }),
    /** The same dates a year earlier. */
    z.object({ kind: z.literal("same_last_year") }),
    z.object({ kind: z.literal("period"), period: PeriodSpec }),
  ]),
);
export type ComparisonSpec = z.infer<typeof ComparisonSpec>;

/** A slot set to null is cleared. */
const slot = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();

/**
 * One message's worth of change to the active intent. A slot left out is unchanged; a slot set to null is
 * cleared; a filter set to null is removed.
 */
export const IntentPatch = z.object({
  /** A KPI name from the ontology (or the words the person used for it). */
  kpi: slot(z.string().min(1)),
  task: slot(Task),
  period: slot(PeriodSpec),
  comparison: slot(ComparisonSpec),
  /** The time level to look at it by (a level of the ontology). Empty or null: let the analysis choose. */
  aggregation: slot(z.string()),
  /** Concept -> value to restrict to, where the concept is one of the ontology's. */
  filters: z.record(z.string().min(1), z.string().nullable()).optional(),
  /** How many earlier windows make up "what it should have been" (default: the analysis's own). */
  baseline: slot(z.number().int().min(1).max(26)),
});
export type IntentPatch = z.infer<typeof IntentPatch>;

/** The active intent: patches merged. Complete enough to run when `validateIntent` says so. */
export const Intent = z.object({
  kpi: z.string().min(1).optional(),
  task: Task.optional(),
  period: PeriodSpec.optional(),
  comparison: ComparisonSpec.optional(),
  aggregation: z.string().optional(),
  filters: z.record(z.string().min(1), z.string()).default({}),
  baseline: z.number().int().min(1).max(26).optional(),
});
export type Intent = z.infer<typeof Intent>;

// --- what validation says --------------------------------------------------------------------------

export const ResolvedWindow = z.object({
  start: Day,
  end: Day,
  days: z.number().int().min(1),
  /** In words, with the dates: "last week (2–8 February 2026)". */
  description: z.string(),
  /** The data's own period label, when the person named one. */
  label: z.string().optional(),
});
export type ResolvedWindow = z.infer<typeof ResolvedWindow>;

export const ResolvedIntent = z.object({
  kpi: z.string(),
  task: Task,
  window: ResolvedWindow,
  /** For a comparison: the other period, and how it was chosen. */
  against: ResolvedWindow.optional(),
  aggregation: z.string(),
  filters: z.record(z.string(), z.string()),
  baseline: z.number().optional(),
});
export type ResolvedIntent = z.infer<typeof ResolvedIntent>;

export const IntentOption = z.object({ value: z.string(), label: z.string() });
export type IntentOption = z.infer<typeof IntentOption>;

export const IntentSlot = z.enum(["kpi", "task", "period", "comparison", "aggregation", "filters"]);
export type IntentSlot = z.infer<typeof IntentSlot>;

export const IntentCheck = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    resolved: ResolvedIntent,
    /** The intent read back in plain words, before anything runs. */
    playback: z.string(),
    /** Things worth saying that are not errors (a span cut at the latest complete day). */
    notes: z.array(z.string()),
  }),
  z.object({
    status: z.literal("ask"),
    /** Which slot the answer fills (for `filters`, `detail` names the concept). */
    slot: IntentSlot,
    detail: z.string().optional(),
    /** The one question to ask the person, in plain words. */
    question: z.string(),
    options: z.array(IntentOption),
  }),
]);
export type IntentCheck = z.infer<typeof IntentCheck>;

// --- intent evals ------------------------------------------------------------------------------------

/** What must be true after a message: a ready intent with these values, or this question. */
export const IntentExpectation = z.object({
  status: z.enum(["ready", "ask"]),
  slot: IntentSlot.optional(),
  kpi: z.string().optional(),
  task: Task.optional(),
  window: z.object({ start: Day, end: Day }).optional(),
  against: z.object({ start: Day, end: Day }).optional(),
  aggregation: z.string().optional(),
  filters: z.record(z.string(), z.string()).optional(),
  /** Words the play-back (or the question) must contain, any case. */
  says: z.array(z.string().min(1)).optional(),
  /** Option values the question must offer. */
  offers: z.array(z.string().min(1)).optional(),
});
export type IntentExpectation = z.infer<typeof IntentExpectation>;

export const IntentTurn = z.object({
  /** What the person typed. */
  say: z.string().min(1),
  /** The change a model should make to the intent from it. */
  set: IntentPatch.optional(),
  /** After this message, with this patch applied. */
  expect: IntentExpectation.optional(),
});
export type IntentTurn = z.infer<typeof IntentTurn>;

export const IntentCase = z.object({
  id: z.string().min(1),
  /** The clock for the case. Packs whose data has a fixed end (`as_of: data_end`) ignore it. */
  today: Day.optional(),
  turns: z.array(IntentTurn).min(1),
});
export type IntentCase = z.infer<typeof IntentCase>;
export const IntentCases = z.array(IntentCase);
