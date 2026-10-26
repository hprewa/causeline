import { nextRungNeeds, type Result, type Rung } from "@causeline/schema";

/**
 * How sure an answer is, in a word and the reasons, worked out from what the answer already carries and never from a model's feeling about it.
 * Two things set it: how strong the evidence in the run is, and how far the expert that produced it is trusted (its rung). The label is the weaker
 * of the two: a draft expert, whose numbers have not been checked against the person's reports, cannot give a "high" answer however strong the
 * run looks, and the answer says why it is held back and what would lift it.
 *
 *   evidence: the change is real beyond the data's ordinary movement; the part named is out of the ordinary for itself (judged against its own
 *   history); the named parts account for most of the change; no thin data was set aside at that level.
 */
export type Confidence = "high" | "moderate" | "low" | "none";

export interface ConfidenceInput {
  rung: Rung | "exploratory";
  /** The expert's numbers were only a plausible sample, not confirmed against the person's reports. */
  unconfirmed?: boolean;
  result: Pick<Result, "status" | "headline" | "findings" | "contributions" | "masking_flags" | "stopped_reason" | "explained">;
}

export interface ConfidenceReport {
  label: Confidence;
  /** How strong the evidence in the run is, before the expert's rung is taken into account. */
  evidence: Confidence;
  /** The label is lower than the evidence alone gives because of the expert's rung. */
  held_back_by?: Rung;
  /** In plain words: what supports it, what weakens it, and what holds it back. */
  because: string[];
}

const ORDER: Confidence[] = ["none", "low", "moderate", "high"];
const lower = (a: Confidence, b: Confidence): Confidence => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

/** The most an expert at each rung can say. */
export const CEILING: Record<Rung, Confidence> = { draft: "low", reconciled: "moderate", calibrated: "moderate", verified: "high" };

const words = (s: string) => s.replace(/_/g, " ");

export function confidenceOf(input: ConfidenceInput): ConfidenceReport {
  const { rung, result } = input;
  if (rung === "exploratory") return { label: "none", evidence: "none", because: ["This is an exploratory answer: no expert covers the question, so there is no rung to rate it by. Read the figures as they are, not as a finding."] };
  if (result.status !== "complete") return { label: "none", evidence: "none", because: [`The analysis declined to answer${result.stopped_reason ? ` (${words(result.stopped_reason)})` : ""}, so there is nothing to rate.`] };

  const because: string[] = [];
  const top = result.findings[0];
  let evidence: Confidence;

  if (!top) {
    // an answer that nothing stands out: it can say it found nothing, not that nothing happened
    evidence = "moderate";
    because.push("The analysis found nothing that stands out. That is all it can say: it does not show that nothing happened.");
  } else {
    let score = 0;
    if (result.headline?.significant) {
      score += 1;
      because.push("The change itself is larger than this data's ordinary movement.");
    } else {
      because.push("The whole did not change by more than the data's ordinary movement; this finding rests on one part standing out, not on the whole.");
    }
    const c = result.contributions.find((x) => x.level === top.dimension && x.node === top.value);
    if (c?.verdict === "new" || c?.verdict === "unusual") {
      score += 1;
      because.push(`${top.value} is outside what it has contributed in recent ordinary periods.`);
    } else if (c?.verdict === "usual") {
      score -= 1;
      because.push(`${top.value} contributes about what it usually does, so it may be context rather than the cause.`);
    } else because.push(`${top.value} was not checked against its own history.`);
    if (result.explained) {
      const pct = Math.round(result.explained.share * 100);
      if (result.explained.share >= 0.5) {
        score += 1;
        because.push(`The parts named account for about ${pct}% of the change.`);
      } else if (result.explained.share < 0.25) {
        score -= 1;
        because.push(`The parts named account for only about ${pct}% of the change; most of it is not explained.`);
      }
    }
    if (result.masking_flags.some((f) => f.type === "small_cells" && f.level === top.dimension)) {
      score -= 1;
      because.push(`Some ${words(top.dimension)} values were too small to judge, so the picture may be incomplete.`);
    }
    evidence = score >= 2 ? "high" : score >= 1 ? "moderate" : "low";
  }

  const ceiling = CEILING[rung];
  const label = lower(evidence, ceiling);
  const held = label !== evidence ? rung : undefined;
  if (held) {
    because.push(`It is held to ${label} because the expert is only ${rung}${input.unconfirmed ? " and its numbers were not confirmed against your reports" : ""}. To lift it: ${nextRungNeeds(rung)}.`);
  } else if (input.unconfirmed && rung === "draft") because.push("The numbers it is built on were not confirmed against your reports.");
  return { label, evidence, ...(held ? { held_back_by: held } : {}), because };
}
