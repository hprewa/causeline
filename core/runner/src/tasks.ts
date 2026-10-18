import type { Comparison, Trend } from "@causeline/schema";
import type { RunContext } from "./context.js";
import { resolvePeriod } from "./period.js";
import { toBuckets, toChildRows } from "./rows.js";
import type { StepFn } from "./steps.js";
import { rate, zScore, zSum } from "./stats.js";
import type { Bucket, Components } from "./types.js";

/**
 * The simple task templates (trend, compare). They use the same maths and the same tools as the deep
 * dive, and nothing about any KPI: a new KPI with a formula gets both for free.
 */

const value = (ctx: RunContext, c: Components) => (ctx.kind === "sum" ? c.num : rate(c));

async function topSeries(ctx: RunContext, stepId: string): Promise<Bucket[]> {
  const counts = await ctx.tools.call(ctx.index.extent(ctx.metric), {}, stepId);
  const top = ctx.ontology.time.levels[0];
  return toBuckets(await ctx.tools.call(ctx.index.series(ctx.metric, top), { start: String(counts[0].min_ts), end: String(counts[0].max_ts) }, stepId));
}

function stop(ctx: RunContext, reason: string, detail: string): void {
  ctx.stop = { reason, detail };
}

/**
 * How the metric has moved period by period: each period against its own like-for-like baseline (the
 * earlier periods that share its calendar flags), with the change points where it left that baseline.
 */
export const trendStep: StepFn = async (ctx, step) => {
  const series = await topSeries(ctx, step.id);
  const n = Number(ctx.inputs.baseline);
  const buckets: Trend["buckets"] = [];
  for (const b of series) {
    const v = value(ctx, b);
    const info = resolvePeriod(series, b.bucket, n, ctx.slots.calendar);
    if ("error" in info || v === null) {
      buckets.push({ bucket: b.bucket, value: v, expected: null, z: null, significant: false });
      continue;
    }
    // a holiday or a peak week with no earlier one like it has nothing comparable: it is shown, not judged
    const sig = (x: Bucket) => ctx.slots.calendar.map((c) => x.slots?.[c] ?? "~").join("|");
    if (info.baselineBuckets.some((x) => sig(x) !== sig(b))) {
      buckets.push({ bucket: b.bucket, value: v, expected: null, z: null, significant: false, note: "no earlier period shares this period's calendar flags, so it is not judged" });
      continue;
    }
    const k = 1 / info.baselineLabels.length;
    const expected = ctx.kind === "sum" ? info.baseComponents.num * k : rate(info.baseComponents);
    const z = ctx.kind === "sum" ? zSum(info.curComponents, info.baseComponents, k) : zScore(info.curComponents, info.baseComponents);
    buckets.push({ bucket: b.bucket, value: v, expected, z, significant: Math.abs(z) >= ctx.th.parent_z });
  }
  // a change point: the first bucket of a run that has left its baseline in one direction
  const changePoints: string[] = [];
  buckets.forEach((b, i) => {
    const prev = buckets[i - 1];
    if (b.significant && !(prev?.significant && Math.sign(prev.z ?? 0) === Math.sign(b.z ?? 0))) changePoints.push(b.bucket);
  });
  ctx.trend = { level: ctx.ontology.time.levels[0], buckets, change_points: changePoints };
};

/**
 * Two periods, or two nodes of one concept, side by side: the difference and whether it is real.
 * Periods are compared as they are; for like-for-like against the usual pattern ask for the change instead.
 */
export const compareStep: StepFn = async (ctx, step) => {
  const concept = String(ctx.inputs.concept ?? "");
  const side = (label: string, c: Components) => ({ label, value: value(ctx, c) ?? 0, volume: c.den });
  const z = (a: Components, b: Components) => (ctx.kind === "sum" ? zSum(a, b, 1) : zScore(a, b));

  let a: Components;
  let b: Components;
  let kind: Comparison["kind"];
  let labels: [string, string];
  if (concept) {
    const [la, lb] = [String(ctx.inputs.a ?? ""), String(ctx.inputs.b ?? "")];
    if (!la || !lb) return stop(ctx, "needs_inputs", `comparing two ${concept} values needs both of them (inputs a and b)`);
    const period = ctx.period!;
    const rows = toChildRows(await ctx.tools.call(ctx.index.slice(ctx.metric, concept), { cur_start: period.cur.start, cur_end: period.cur.end, base_start: period.cur.start, base_end: period.cur.end }, step.id));
    const find = (label: string) => rows.find((r) => r.node === label)?.cur;
    const ca = find(la);
    const cb = find(lb);
    if (!ca || !cb) return stop(ctx, "node_not_found", `${[!ca ? la : "", !cb ? lb : ""].filter(Boolean).join(" and ")} not found among the ${concept} values in ${period.label}; available: ${rows.slice(0, 12).map((r) => r.node).join(", ")}`);
    [a, b, kind, labels] = [ca, cb, "nodes", [la, lb]];
  } else {
    const against = String(ctx.inputs.against ?? "");
    if (!against) return stop(ctx, "needs_inputs", "comparing two periods needs the second one (input against), or a concept with two of its values (inputs concept, a, b)");
    const series = await topSeries(ctx, step.id);
    const pa = series.find((x) => x.bucket === String(ctx.inputs.period));
    const pb = series.find((x) => x.bucket === against);
    if (!pa || !pb) return stop(ctx, "period_not_found", `period "${!pa ? ctx.inputs.period : against}" not found; available: ${series[0]?.bucket} .. ${series[series.length - 1]?.bucket}`);
    [a, b, kind, labels] = [pa, pb, "periods", [pa.bucket, pb.bucket]];
  }
  const va = value(ctx, a);
  const vb = value(ctx, b);
  if (va === null || vb === null) return stop(ctx, "empty_period", "one side of the comparison has no volume");
  const zz = z(a, b);
  ctx.comparison = {
    kind,
    metric: ctx.metric,
    ...(concept ? { concept } : {}),
    a: side(labels[0], a),
    b: side(labels[1], b),
    difference: va - vb,
    relative_difference: vb === 0 ? null : (va - vb) / Math.abs(vb),
    z: zz,
    significant: Math.abs(zz) >= ctx.th.parent_z,
  };
};
