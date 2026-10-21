import { z } from "zod";

/**
 * Where an expert (and the KPI under it) stands, from least to most trusted. Each rung is earned by a check that has been run, never claimed:
 * - draft: defined, not checked against the person's own reports.
 * - reconciled: its numbers match the person's own reports (several numbers, from different periods and slices) and the automatic checks pass.
 * - calibrated: replayed over ordinary past periods it stays quiet (it does not cry wolf).
 * - verified: it finds what really happened (known incidents it was not tuned on, or faults planted in the person's own data).
 */
export const RUNGS = ["draft", "reconciled", "calibrated", "verified"] as const;
export const Rung = z.enum(RUNGS);
export type Rung = z.infer<typeof Rung>;

/** Files and saved states written before this ladder carry no marker; from this value on, the names mean what is said above. */
export const LADDER_VERSION = 2;

export const rankOf = (r: Rung): number => RUNGS.indexOf(r);
export const atLeast = (r: Rung, min: Rung): boolean => rankOf(r) >= rankOf(min);
export const lowerOf = (a: Rung, b: Rung): Rung => (rankOf(a) <= rankOf(b) ? a : b);

/** One change of rung, kept so anyone can see who changed what, when and why. */
export const StatusChange = z.object({
  at: z.string(),
  /** `kpi:<name>` or `expert:<name>`. */
  subject: z.string().min(1),
  from: Rung,
  to: Rung,
  why: z.string().min(1),
  /** The tool or step that made the change; the person is named when they gave the number that caused it. */
  by: z.string().min(1),
});
export type StatusChange = z.infer<typeof StatusChange>;

/**
 * The earlier ladder was draft, provisional, verified, where "verified" meant two confirmed numbers from different angles. Read with the new
 * names: draft stays draft; provisional becomes draft with the flag "numbers not confirmed"; verified becomes reconciled (it has not been
 * calibrated or tested against incidents).
 */
export function migrateLegacyStatus(old: unknown): { status: Rung; unconfirmed_numbers: boolean } {
  if (old === "verified") return { status: "reconciled", unconfirmed_numbers: false };
  if (old === "provisional") return { status: "draft", unconfirmed_numbers: true };
  return { status: "draft", unconfirmed_numbers: false };
}

/** What a rung means, in words for the person, for use after "this expert" (so every screen and answer says the same thing). */
export function statusSentence(status: Rung | "exploratory", unconfirmed = false): string {
  const base: Record<Rung | "exploratory", string> = {
    draft: "has not been checked against your own reports yet",
    reconciled: "has numbers that match your own reports, but has not been tested for false alarms or against known incidents",
    calibrated: "has numbers that match your reports and stays quiet in ordinary periods, but has not yet been shown to find known incidents",
    verified: "has numbers that match your reports, stays quiet in ordinary periods, and finds known incidents",
    exploratory: "is an exploratory answer: no expert covers this question",
  };
  return base[status] + (unconfirmed && status === "draft" ? "; the numbers it was built on were not confirmed against your reports" : "");
}

/** What earns the next rung. */
export function nextRungNeeds(status: Rung): string {
  switch (status) {
    case "draft":
      return "confirm several numbers from your own reports, from different periods and slices";
    case "reconciled":
      return "replay it over ordinary past periods and show it rarely raises a false alarm";
    case "calibrated":
      return "show it finds known incidents it was not tuned on, or faults planted in your own data";
    case "verified":
      return "";
  }
}

/**
 * Read the status of an older file. Used where a saved file may predate the marker. `ladder` is the file's own marker; without it the old names apply.
 */
export function readStatus(raw: { status?: unknown; ladder?: unknown; unconfirmed_numbers?: unknown }): { status: Rung; unconfirmed_numbers: boolean } {
  if (raw.ladder === LADDER_VERSION) {
    const parsed = Rung.safeParse(raw.status);
    return { status: parsed.success ? parsed.data : "draft", unconfirmed_numbers: raw.unconfirmed_numbers === true };
  }
  const old = migrateLegacyStatus(raw.status);
  return { status: old.status, unconfirmed_numbers: raw.unconfirmed_numbers === true || old.unconfirmed_numbers };
}
