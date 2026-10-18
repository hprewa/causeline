import { findCheck, findEvidence, findExtent, findProfile, findSeries, findSlice, type ToolsMeta } from "@causeline/schema";

/**
 * Finds a tool by what it answers (a metric split by a concept, a metric by a time level) from the
 * pack's tools.meta.yaml. The runner never builds a tool name, so how tools are named, and which
 * database they run on, are the pack's business.
 */
export class ToolIndex {
  constructor(readonly meta: ToolsMeta) {}

  private need(found: string | undefined, what: string): string {
    if (!found) throw new Error(`no tool provides ${what}; run \`causeline generate\` for the pack (or check data.yaml)`);
    return found;
  }

  /** `metric` split by `by`, confined by exactly these filter concepts (their values are passed as params of the same name). */
  slice(metric: string, by: string, filters: string[] = []): string {
    return this.need(findSlice(this.meta, metric, by, filters), `${metric} split by ${by}${filters.length ? ` within ${filters.join(", ")}` : ""}`);
  }

  /** `metric` by bucket at a time level, optionally confined to one value of one concept. */
  series(metric: string, level: string, filters: string[] = []): string {
    return this.need(findSeries(this.meta, metric, level, filters), `${metric} by ${level}${filters.length ? ` for ${filters.join(", ")}` : ""}`);
  }

  extent(metric: string): string {
    return this.need(findExtent(this.meta, metric), `the extent of ${metric}`);
  }

  evidence(source: string): string {
    return this.need(findEvidence(this.meta, source), `evidence ${source}`);
  }

  profile(metric: string, cycle: string): string {
    return this.need(findProfile(this.meta, metric, cycle), `${metric} by ${cycle}`);
  }

  check(check: string, opts: { fact?: string; metric?: string; arg?: string } = {}): string {
    return this.need(findCheck(this.meta, check, opts), `check ${check}${opts.arg ? ` ${opts.arg}` : ""}`);
  }

  /** Every evidence source the pack defines, with the concepts each is about. */
  evidenceSources(): { source: string; about: string[] }[] {
    return Object.values(this.meta.tools).flatMap((m) => (m.kind === "evidence" ? [{ source: m.evidence, about: m.about }] : []));
  }

  /** The concepts an evidence tool is about. */
  evidenceAbout(source: string): string[] {
    const m = this.meta.tools[this.evidence(source)];
    return m.kind === "evidence" ? m.about : [];
  }
}
