import { z } from "zod";
import { MaskingFlagType } from "./result.js";

export const TopFindingExpectation = z.object({
  dimension: z.string().min(1),
  value: z.string().min(1),
  /** The finding must be confined to these nodes, as {level: node}. */
  scope: z.record(z.string(), z.string()).optional(),
  /** Whether the change is a rate change or a change in volume mix. */
  effect: z.enum(["rate", "mix"]).optional(),
  /** The metric the finding is about (a driver, for a product metric). */
  metric: z.string().min(1).optional(),
});
export type TopFindingExpectation = z.infer<typeof TopFindingExpectation>;

/** What an evidence step must have fetched: the source, how many records, and words the records must (not) contain. */
export const EvidenceExpectation = z.object({
  source: z.string().min(1),
  min_rows: z.number().int().nonnegative().default(1),
  contains: z.array(z.string().min(1)).optional(),
  /** Words that must not appear in the records: a decoy about another node must not be returned. */
  excludes: z.array(z.string().min(1)).optional(),
});
export type EvidenceExpectation = z.infer<typeof EvidenceExpectation>;

export const Expectation = z
  .object({
    top_finding: TopFindingExpectation.optional(),
    /** Each of these must be among the reported findings, in any position (the culprit and a finding that describes the same records another way can tie for first). */
    findings_include: z.array(TopFindingExpectation).optional(),
    must_mention: z.array(z.string().min(1)).optional(),
    must_not_claim: z.array(z.string().min(1)).optional(),
    stopped_reason: z.string().min(1).optional(),
    /** The run must report no findings at all (a clean period). */
    no_findings: z.boolean().optional(),
    /** Masking flags the run must raise. */
    masking_flags: z.array(MaskingFlagType).optional(),
    /** Supporting records the run must have fetched, in the chain from symptom to root evidence. */
    evidence: z.array(EvidenceExpectation).optional(),
    /** The headline must (not) be a real change: for the value template. */
    significant: z.boolean().optional(),
    /** The trend must list at least these periods as change points. */
    change_points_include: z.array(z.string().min(1)).optional(),
    /** The trend must list no change points (a seasonal pattern is not one). */
    no_change_points: z.boolean().optional(),
    /** The comparison's difference must (not) be significant. */
    comparison_significant: z.boolean().optional(),
  })
  .refine(
    (e) =>
      e.top_finding !== undefined ||
      (e.findings_include?.length ?? 0) > 0 ||
      (e.must_mention?.length ?? 0) > 0 ||
      (e.must_not_claim?.length ?? 0) > 0 ||
      e.stopped_reason !== undefined ||
      e.no_findings === true ||
      (e.masking_flags?.length ?? 0) > 0 ||
      (e.evidence?.length ?? 0) > 0 ||
      e.significant !== undefined ||
      (e.change_points_include?.length ?? 0) > 0 ||
      e.no_change_points === true ||
      e.comparison_significant !== undefined,
    { message: "expect must assert at least one of top_finding, findings_include, must_mention, must_not_claim, stopped_reason, no_findings, masking_flags" },
  );
export type Expectation = z.infer<typeof Expectation>;

/** What the runner is asked to do for a case (the agent is given only the question). */
export const EvalInputs = z
  .object({
  metric: z.string().min(1),
  /** A period label; empty when the case gives a date range in `more` (start_date, end_date, aggregation). */
  period: z.string().default(""),
  baseline: z.number().int().positive().optional(),
  playbook: z.string().min(1).default("metric_change"),
  /** Further playbook inputs (for compare: against, concept, a, b). */
  more: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  })
  .refine((i) => i.period !== "" || (!!i.more?.start_date && !!i.more?.end_date), { message: "a case needs a period label or a date range (more.start_date and more.end_date)" });
export type EvalInputs = z.infer<typeof EvalInputs>;

export const EvalCase = z.object({
  id: z.string().min(1),
  /** The raw --fault string used to generate the dataset this case runs against. */
  /** How to build the dataset (fault flags for a synthetic generator). Absent: run on the pack as it is, as a user's real data. */
  setup: z.string().min(1).optional(),
  question: z.string().min(1),
  /** Inputs for a runner-level run; a case without them can only be scored at agent level. */
  inputs: EvalInputs.optional(),
  expect: Expectation,
  /**
   * Says why this case is expected to fail today (a real thing the analysis does not yet do). A failing gap case is reported as a known
   * gap and does not fail the run; a gap case that PASSES fails the run until the marker is removed, so a gap cannot be forgotten
   * once it is closed.
   */
  gap: z.string().min(1).optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const EvalCases = z.array(EvalCase);
export type EvalCases = z.infer<typeof EvalCases>;
