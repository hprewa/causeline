import type { PlaybookStep } from "@causeline/schema";
import type { RunContext } from "./context.js";
import { checkPersistence, hierarchyDrill, rankDimensions, timeDrill } from "./drill.js";
import { seasonalExpectation } from "./expectation.js";
import { resolveWindow } from "./window.js";
import { rate, zScore, zSum } from "./stats.js";
import { compareStep, trendStep } from "./tasks.js";

export type StepFn = (ctx: RunContext, step: PlaybookStep) => Promise<void>;

/** Stop the run: the reason lands in result.json as stopped_reason / stopped_detail. */
function stop(ctx: RunContext, reason: string, detail: string): void {
  ctx.stop = { reason, detail };
}

/** Resolve the period, then stop if any sizeable node has far fewer rows than usual. */
const coverageAndCounts: StepFn = async (ctx, step) => {
  const counts = await ctx.tools.call(ctx.index.extent(ctx.metric), {}, step.id);
  const total = Number(counts[0]?.n_rows ?? 0);
  if (total === 0) return stop(ctx, "empty_data", "the entity table has no rows");

  const info = await resolveWindow({ tools: ctx.tools, index: ctx.index, ontology: ctx.ontology, metric: ctx.metric, inputs: ctx.inputs, extent: { start: String(counts[0].min_ts), end: String(counts[0].max_ts) }, stepId: step.id });
  if ("error" in info) return stop(ctx, info.error, info.detail);
  const series = info.periodSeries ?? [];
  ctx.period = info;
  ctx.window = { ...info.cur };
  ctx.sumScale = 1 / info.baselineLabels.length;
  ctx.seasonNotes.push(...info.notes);
  // calendar flags the whole period agrees on restrict the baseline rows of every node query to the same flags
  // (a flag that varies inside the period, such as a holiday in an ordinary week, leaves the flagged
  // rows out of the node comparisons on both sides: they are judged separately at the day level)
  for (const c of ctx.slots.calendar) {
    const v = info.slots[c];
    ctx.slotFilter[c] = v !== null && v !== undefined ? v : "0";
  }
  // a date range inside part of a cycle (a Wednesday) is compared with the same part of the cycle
  Object.assign(ctx.slotFilter, info.cycleFilter ?? {});

  const params = { cur_start: info.cur.start, cur_end: info.cur.end, base_start: info.base.start, base_end: info.base.end, ...Object.fromEntries(Object.entries(info.cycleFilter ?? {}).map(([n, v]) => [`s_${n}`, v])) };
  // periods in the baseline window (a like-for-like baseline can skip periods that sit between its ends)
  const periods = series.filter((b) => b.bucket_start >= info.base.start && b.bucket_end <= info.base.end).length || info.baselineLabels.length;
  const gaps: string[] = [];
  for (const levels of Object.values(ctx.ontology.hierarchies)) {
    for (const level of levels) {
      // volume per node, from the metric's own split by that level: a node far below its usual share is missing data
      for (const row of await ctx.tools.call(ctx.index.slice(ctx.metric, level), params, step.id)) {
        const baseAvg = Number(row.base_den) / periods;
        const cur = Number(row.cur_den);
        // only nodes big enough to judge: thin nodes are small cells, not missing data
        if (baseAvg >= ctx.minVolume && cur < ctx.th.coverage_ratio * baseAvg) {
          gaps.push(`${level}=${row.node}: ${cur} rows vs a baseline average of ${Math.round(baseAvg)} per period (${Math.round((cur / baseAvg) * 100)}% of usual)`);
        }
      }
    }
  }
  if (gaps.length > 0) {
    const shown = gaps.slice(0, 10).join("; ");
    stop(ctx, "data_quality", `${gaps.length} node(s) have under ${ctx.th.coverage_ratio * 100}% of their usual rows: ${shown}${gaps.length > 10 ? "; ..." : ""}`);
  }
};

/** Headline change vs baseline, and where the trend first leaves the baseline. */
const changeVsBaseline: StepFn = async (ctx, step) => {
  const period = ctx.period;
  if (!period) throw new Error("change_vs_baseline needs the data-check step to run first");
  // a ratio compares rates; a total compares the period's total with the baseline's average per period
  const sum = ctx.kind === "sum";
  const value = sum ? period.curComponents.num : rate(period.curComponents);
  const naive = sum ? period.baseComponents.num * ctx.sumScale : rate(period.baseComponents);
  let expected = naive;
  // with declared seasonality the baseline is what the period should have been at its own mix of
  // weekdays/hours/flags; the pooled figure stays as baseline_naive
  const expectation = await seasonalExpectation(ctx.tools, ctx.index, ctx.ontology, ctx.metric, ctx.kind, period, step.id);
  if (expectation === "none_comparable") {
    return stop(ctx, "no_comparable_baseline", "no day of the period has a comparable day in the baseline (same place in every cycle, same calendar flags); a pooled comparison would be misleading");
  }
  if (expectation) {
    expected = expectation.expected;
    ctx.seasonNotes.push(`headline baseline is the seasonally expected value (${expectation.judged} of ${expectation.total} buckets had a comparable baseline)`);
  }
  const baseline = expected;
  if (value === null || baseline === null || period.curComponents.den <= 0 || period.baseComponents.den <= 0) {
    return stop(ctx, "empty_period", "the period or its baseline has no volume");
  }
  // a rate (everything between 0 and 1) reads as a percentage; an average or a total does not
  const fraction = !sum && value >= 0 && value <= 1 && baseline >= 0 && baseline <= 1;
  ctx.headline = {
    metric: ctx.metric,
    kind: ctx.kind,
    format: fraction ? "fraction" : "number",
    value,
    baseline,
    ...(expectation && naive !== null ? { baseline_naive: naive } : {}),
    change: value - baseline,
    z: expectation ? expectation.z : sum ? zSum(period.curComponents, period.baseComponents, ctx.sumScale) : zScore(period.curComponents, period.baseComponents),
    ...(fraction ? {} : { relative_change: baseline === 0 ? null : (value - baseline) / Math.abs(baseline) }),
  };

  ctx.headline.significant = Math.abs(ctx.headline.z ?? 0) >= ctx.th.parent_z;

  const sign = Math.sign(ctx.headline.change);
  const deviates = (b: { num: number; den: number; sq?: number }) => {
    if (sum) return Math.sign(b.num - baseline) === sign && Math.abs(zSum(b, period.baseComponents, ctx.sumScale)) >= ctx.th.onset_z;
    const r = rate(b);
    return r !== null && Math.sign(r - baseline) === sign && Math.abs(zScore(b, period.baseComponents)) >= ctx.th.onset_z;
  };
  const trend = period.trend;
  // the period itself is judged against its seasonal expectation when it has one; earlier periods against the pool
  const periodDeviates = expectation ? Math.sign(expectation.z) === sign && Math.abs(expectation.z) >= ctx.th.onset_z : deviates(period.curComponents);
  if (!periodDeviates) {
    ctx.onset = null;
    return;
  }
  let onset = trend[trend.length - 1].bucket;
  for (let i = trend.length - 2; i >= 0 && deviates(trend[i]); i--) onset = trend[i].bucket;
  ctx.onset = onset;
};

const guidedDrill: StepFn = async (ctx, step) => {
  if (step.over === "time") return timeDrill(ctx, step.id);
  if (step.over === "hierarchies") return hierarchyDrill(ctx, step.id);
  throw new Error(`guided_drill step "${step.id}" needs over: time | hierarchies`);
};

const rankDims: StepFn = async (ctx, step) => {
  const within = step.within ? ctx.stepKinds.get(step.within) : undefined;
  const insideNode = within?.compute === "guided_drill" && within.over === "hierarchies";
  await rankDimensions(ctx, step.id, insideNode ? "node" : "window");
};

const persistence: StepFn = async (ctx, step) => checkPersistence(ctx, step.id);

/**
 * The concept values the drill pointed at, best first: findings (scoped ones first, then by size), then
 * each hierarchy node the drill descended into. An evidence step asks only about the concepts its source
 * is about, so a playbook never names a column or a table.
 */
export function culpritConcepts(ctx: RunContext): Record<string, string> {
  const out: Record<string, string> = {};
  const time = new Set(ctx.ontology.time.levels);
  const take = (concept: string, value: string) => {
    if (!time.has(concept) && out[concept] === undefined) out[concept] = value;
  };
  const drafts = [...ctx.drafts].sort((a, b) => Number(!!b.scope) - Number(!!a.scope) || Math.abs(b.impact) - Math.abs(a.impact));
  for (const d of drafts) {
    for (const [k, v] of Object.entries(d.scope ?? {})) take(k, v);
    take(d.dimension, d.value);
  }
  for (const p of ctx.path) if (p.hierarchy && p.hierarchy !== "time" && p.decision === "drill" && p.node && p.node !== "(none)") take(p.level, p.node);
  return out;
}

/** Ask an evidence source for records about the culprits found so far. Supporting material, never a finding. */
const evidenceStep: StepFn = async (ctx, step) => {
  // "*" means every evidence source the pack defines (none is fine); each is asked only if it has something to be asked about
  if (step.evidence === "*") {
    for (const { source } of ctx.index.evidenceSources()) {
      const before = ctx.evidence.length;
      await askEvidence(ctx, step.id, source);
      const last = ctx.evidence[ctx.evidence.length - 1];
      if (ctx.evidence.length > before && last.skipped) ctx.evidence.pop();
    }
    return;
  }
  await askEvidence(ctx, step.id, step.evidence!);
};

async function askEvidence(ctx: RunContext, stepId: string, source: string): Promise<void> {
  const step = { id: stepId };
  const about = ctx.index.evidenceAbout(source);
  const known = culpritConcepts(ctx);
  const asked = Object.fromEntries(about.filter((c) => known[c] !== undefined).map((c) => [c, known[c]]));
  const window = ctx.period?.cur ?? ctx.window;
  if (!window) throw new Error("an evidence step needs the data-check step to run first");
  if (Object.keys(asked).length === 0) {
    ctx.evidence.push({ step: step.id, source, about: {}, window, kind: "supporting", rows: 0, sample: [], skipped: `no culprit was found for ${about.join(" or ")}, so there is nothing to ask ${source} about` });
    return;
  }
  const rows = await ctx.tools.call(ctx.index.evidence(source), { start: window.start, end: window.end, ...asked }, step.id);
  ctx.evidence.push({
    step: step.id,
    source,
    about: asked,
    window,
    kind: "supporting",
    rows: rows.length,
    sample: rows.slice(0, EVIDENCE_SAMPLE).map((r) => JSON.parse(JSON.stringify(r))),
  });
}

/** Rows of an evidence source kept in result.json: enough to read, not a data dump. */
const EVIDENCE_SAMPLE = 10;

export const COMPUTE: Record<string, StepFn> = {
  evidence: evidenceStep,
  trend: trendStep,
  compare: compareStep,
  coverage_and_counts: coverageAndCounts,
  change_vs_baseline: changeVsBaseline,
  guided_drill: guidedDrill,
  rank_dimensions: rankDims,
  persistence,
};
