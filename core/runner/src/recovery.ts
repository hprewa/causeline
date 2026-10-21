import type { RunContext } from "./context.js";
import { toBuckets } from "./rows.js";
import { zScore, zSum } from "./stats.js";

/** Later periods looked at for each finding, at most. */
const LATER = 4;

/**
 * Has a culprit gone back to normal since the period asked about? For each finding that names a node, take the node's own series at the top
 * time level for the periods after the one analysed, and judge each against the same baseline the finding was judged against. If the newest
 * of those is no longer off in the direction of the change, the finding is `recovered`; if it still is, `ongoing`. Nothing is said when the
 * data holds no period after the one asked about, or only periods too small to judge.
 */
export async function recoveryStep(ctx: RunContext, stepId: string): Promise<void> {
  const period = ctx.period;
  const series = period?.periodSeries ?? [];
  if (!period || series.length === 0) return;
  const level = ctx.ontology.time.levels[0];
  const lastEnd = series[series.length - 1].bucket_end;
  if (lastEnd <= period.cur.end) return; // the period asked about is the newest
  for (const draft of ctx.drafts) {
    if (!draft.persist || draft.effect === "mix") continue;
    const { col, value, base } = draft.persist;
    const sign = Math.sign(draft.impact || ctx.headline?.change || 0);
    if (sign === 0) continue;
    const rows = toBuckets(await ctx.tools.call(ctx.index.series(ctx.metric, level, [col]), { start: period.cur.end, end: lastEnd, [col]: value }, stepId));
    const later = rows.filter((b) => b.bucket_start >= period.cur.end && b.den >= ctx.minVolume).slice(0, LATER);
    if (later.length === 0) continue;
    const off = (b: (typeof later)[number]) => {
      if (ctx.kind === "sum") return Math.sign(b.num - base.num * ctx.sumScale) === sign && Math.abs(zSum(b, base, ctx.sumScale)) >= ctx.th.parent_z;
      const baseRate = base.den > 0 ? base.num / base.den : null;
      return baseRate !== null && Math.sign(b.num / b.den - baseRate) === sign && Math.abs(zScore(b, base)) >= ctx.th.parent_z;
    };
    const stillOff = off(later[later.length - 1]);
    draft.after = {
      status: stillOff ? "ongoing" : "recovered",
      periods: later.length,
      detail: `${later.filter(off).length} of the ${later.length} period${later.length === 1 ? "" : "s"} after it ${later.filter(off).length === 1 ? "is" : "are"} still off in the same direction${stillOff ? ", including the newest" : ", and the newest is not"}`,
    };
    draft.evidence = [...new Set([...draft.evidence, stepId])];
  }
}
