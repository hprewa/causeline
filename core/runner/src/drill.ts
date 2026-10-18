import type { PathNode } from "@causeline/schema";
import { round6, type FindingDraft, type HierarchyCandidate, type RunContext } from "./context.js";
import { decomposeAgainstBaseline, decomposeBuckets, decomposeRatio, decomposeSum, type BucketItem, type Decomposition } from "./decompose.js";
import { decideLevel, dominantRun, type LevelDecision } from "./masking.js";
import type { Window } from "./period.js";
import { toBuckets, toChildRows } from "./rows.js";
import { expectedFor, matchesFilter, slotFilterFor } from "./seasonal.js";
import type { Bucket, Row } from "./types.js";
import { rate, zScore, zSum } from "./stats.js";

const adverse = (ctx: RunContext) => (ctx.direction === "higher_is_better" ? -1 : 1);

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} is not available; the data-check step must run first`);
  return v;
}

function windowParams(ctx: RunContext): Record<string, string> {
  const cur = need(ctx.window, "the drill window");
  const base = need(ctx.period, "the period").base;
  const slots = Object.fromEntries(ctx.slots.all.map((n) => [`s_${n}`, ctx.slotFilter[n] ?? ""]));
  return { cur_start: cur.start, cur_end: cur.end, base_start: base.start, base_end: base.end, ...slots };
}

/** Each bucket with the baseline buckets that sit at the same place in every cycle (and carry the same flags). */
function withExpectations(ctx: RunContext, rows: Bucket[], baseline: Bucket[]): BucketItem[] {
  return rows.map((b) => {
    const e = expectedFor(b, baseline, ctx.slots.all);
    return { node: b.bucket, cur: { num: b.num, den: b.den, ...(b.sq !== undefined ? { sq: b.sq } : {}) }, base: e.base, matches: e.matches };
  });
}

function noteUnjudged(ctx: RunContext, level: string, items: BucketItem[]): void {
  const lost = items.filter((i) => i.base === null).map((i) => i.node);
  if (lost.length === 0) return;
  const shown = lost.slice(0, 5).join(", ") + (lost.length > 5 ? ", ..." : "");
  const note = `${lost.length} ${level} bucket(s) had no comparable baseline and were not judged: ${shown}`;
  if (!ctx.seasonNotes.includes(note)) ctx.seasonNotes.push(note);
}

/** Split a child breakdown the way this metric's kind requires. */
function decomposeChildren(ctx: RunContext, rows: Row[]): Decomposition | null {
  const children = toChildRows(rows);
  return ctx.kind === "sum" ? decomposeSum(children, ctx.sumScale) : decomposeRatio(children);
}

function decide(ctx: RunContext, d: Decomposition | null): LevelDecision {
  return decideLevel(d, { minVolume: ctx.minVolume, direction: ctx.direction, th: ctx.th });
}

function numbers(d: Decomposition | null, dec: LevelDecision, culprit?: string): Record<string, unknown> {
  const c = d?.children.find((x) => x.node === culprit);
  return {
    change: round6(d?.parent.change),
    parent_rate: round6(d?.parent.curRate),
    baseline_rate: round6(d?.parent.baseRate),
    parent_z: round6(d?.parent.z),
    children: d?.children.length ?? 0,
    share: round6(dec.share),
    rate_total: round6(d?.rateTotal),
    mix_total: round6(d?.mixTotal),
    culprit_rate: round6(c?.curRate),
    culprit_baseline_rate: round6(c?.baseRate),
    culprit_volume: c?.cur.den,
    culprit_z: round6(c?.z),
    reason: dec.reason,
  };
}

function addFlags(ctx: RunContext, level: string, node: string | undefined, dec: LevelDecision): void {
  for (const f of dec.flags) {
    ctx.flags.push({ level, node: f.nodes?.length === 1 ? f.nodes[0] : node, type: f.type, detail: f.detail });
  }
}

/** "when": descend the time levels finer than the period, narrowing the window to the buckets that carry the change. */
export async function timeDrill(ctx: RunContext, stepId: string): Promise<void> {
  const period = need(ctx.period, "the period");
  ctx.window ??= { ...period.cur };
  const seasonal = ctx.slots.all.length > 0;
  if (ctx.kind === "sum" && !seasonal) {
    // Day-of-week and hour-of-day patterns make a total smaller on some days and in some hours
    // than the baseline's average, so comparing slots inside the period would flag healthy data.
    ctx.path.push({
      level: ctx.ontology.time.levels[1] ?? ctx.ontology.time.levels[0],
      node: "(not applied)",
      decision: "broad",
      hierarchy: "time",
      numbers: { reason: "time localisation inside the period is not applied to additive metrics; the change is located by hierarchy and dimension" },
    });
    return;
  }
  const timeLevels = new Set(ctx.ontology.time.levels);
  let scale = 1; // current-volume share of the narrowed window within the period

  for (const level of ctx.ontology.time.levels.slice(1)) {
    const window = ctx.window!;
    const rows = toBuckets(await ctx.tools.call(ctx.index.series(ctx.metric, level), { start: window.start, end: window.end }, stepId));
    // with declared seasonality every bucket is compared with the baseline buckets at the same place in each cycle
    let baseBuckets: Bucket[] = [];
    let d: Decomposition | null;
    if (seasonal) {
      baseBuckets = toBuckets(await ctx.tools.call(ctx.index.series(ctx.metric, level), { start: period.base.start, end: period.base.end }, stepId));
      const items = withExpectations(ctx, rows, baseBuckets);
      noteUnjudged(ctx, level, items);
      d = decomposeBuckets(items, ctx.kind);
    } else {
      d = decomposeAgainstBaseline(rows.map((b) => ({ node: b.bucket, cur: { num: b.num, den: b.den } })), period.baseComponents);
    }
    if (seasonal && level === ctx.ontology.time.levels[1]) {
      // totals: the node queries see only the days that pass the calendar filter on both sides, so the
      // baseline total is scaled by the number of such days now against then, not by 1 / periods
      const now = rows.filter((b) => matchesFilter(b, ctx.slotFilter)).length;
      const then = baseBuckets.filter((b) => matchesFilter(b, ctx.slotFilter)).length;
      if (now > 0 && then > 0) ctx.sumScale = now / then;
    }
    if (!d || d.parent.cur.den < ctx.minVolume) {
      ctx.path.push({
        level: level,
        node: "(window)",
        decision: "insufficient_volume",
        hierarchy: "time",
        numbers: { reason: !d && seasonal ? "no bucket in the window has a comparable baseline" : "window volume below min_volume" },
      });
      return;
    }
    const run = dominantRun(d, ctx.th, ctx.direction);
    const base = numbers(d, { decision: "broad", culprit: null, share: run?.share ?? null, flags: [], reason: "", informative: true });
    if (!run) {
      ctx.path.push({
        level: level,
        node: "(whole window)",
        decision: "broad",
        hierarchy: "time",
        numbers: { ...base, reason: "the change is spread across the window, not confined to one slot" },
      });
      // nothing stands out at this grain, but a short slot can still hide inside a coarse bucket (a bad
      // night inside an ordinary day), so look at the finer levels over the same window too. Only for
      // rates: a total's day-to-day swings are wider than its sampling variance, so fine buckets of a
      // total would raise false alarms.
      if (ctx.kind === "sum") return;
      continue;
    }

    const first = rows[run.from];
    const last = rows[run.to];
    const label = run.from === run.to ? first.bucket : `${first.bucket}..${last.bucket}`;
    const slot = d.children.slice(run.from, run.to + 1);
    const slotDen = slot.reduce((a, c) => a + c.cur.den, 0);
    if (run.masked) {
      ctx.flags.push({
        level: level,
        node: label,
        type: "dispersion",
        detail: `the period-level change is not significant (z=${d.parent.z.toFixed(1)}) but ${label} is significantly worse`,
      });
    }
    ctx.path.push({
      level: level,
      node: label,
      decision: run.masked ? "masked" : "drill",
      hierarchy: "time",
      numbers: {
        ...base,
        share: round6(run.share),
        reason: run.masked ? "the change looks flat overall but this slot is significantly worse" : `${((run.share ?? 0) * 100).toFixed(0)}% of the change falls in this slot`,
      },
    });
    // the deepest narrowing is the time finding; earlier (coarser) ones are superseded
    ctx.drafts = ctx.drafts.filter((x) => !timeLevels.has(x.dimension));
    ctx.drafts.push({
      dimension: level,
      value: label,
      impact: slot.reduce((a, c) => a + c.contribution, 0) * (ctx.kind === "sum" ? 1 : scale),
      effect: "rate",
      evidence: [stepId],
    });
    scale *= slotDen / d.parent.cur.den;
    ctx.window = { start: first.bucket_start, end: last.bucket_end };
    if (seasonal) {
      // from here on the baseline rows of every node query must sit in the same slots as the narrowed window
      const inRun = rows.slice(run.from, run.to + 1);
      Object.assign(ctx.slotFilter, slotFilterFor(inRun, ctx.slots.all));
      const comparable = baseBuckets.filter((b) => matchesFilter(b, ctx.slotFilter)).length;
      if (comparable > 0) ctx.sumScale = inRun.length / comparable;
    }
  }
}

interface Deepest {
  draft: FindingDraft;
  candidate: HierarchyCandidate;
}

interface ChainResult {
  /** Deepest level that actually localised something (a level with one child does not). */
  deepest?: Deepest;
  /**
   * Where the chain stopped without a culprit. `diluted`: the level produced a decomposition but no
   * child stood out, so the change (or a hidden pocket of it) may be too thin to see at this grain
   * and a deeper level is worth sweeping.
   */
  stop?: { index: number; diluted: boolean };
}

/** Walk one hierarchy top-down from a level, taking children of the current node only. */
async function chain(
  ctx: RunContext,
  stepId: string,
  hierarchy: string,
  levels: string[],
  startIndex: number,
  startParent: string | undefined,
  startScale: number,
): Promise<ChainResult> {
  const params = windowParams(ctx);
  let parent = startParent;
  let scale = startScale;
  let deepest: Deepest | undefined;
  for (let i = startIndex; i < levels.length; i++) {
    const level = levels[i];
    const tool = ctx.index.slice(ctx.metric, level, i === 0 ? [] : [levels[i - 1]]);
    const callParams = i === 0 ? params : { ...params, [levels[i - 1]]: parent! };
    const d = decomposeChildren(ctx, await ctx.tools.call(tool, callParams, stepId));
    const dec = decide(ctx, d);
    ctx.path.push({
      level,
      node: dec.culprit ?? "(none)",
      decision: dec.decision,
      hierarchy,
      ...(parent ? { parent } : {}),
      numbers: numbers(d, dec, dec.culprit ?? undefined),
    });
    addFlags(ctx, level, parent, dec);
    if (!d || !dec.culprit) {
      return { deepest, stop: { index: i, diluted: !!d && dec.decision === "broad" } };
    }

    const child = d.children.find((c) => c.node === dec.culprit)!;
    if (dec.informative) {
      deepest = {
        draft: {
          dimension: level,
          value: child.node,
          impact: (dec.effect === "mix" ? child.mixEffect : child.contribution) * scale,
          effect: dec.effect,
          evidence: [stepId],
          persist: { col: level, value: child.node, base: child.base },
        },
        candidate: { hierarchy, level, node: child.node, base: child.base, scaleAfter: scale * (child.cur.den / d.parent.cur.den) },
      };
    }
    scale *= child.cur.den / d.parent.cur.den;
    parent = dec.culprit;
  }
  return { deepest };
}

/**
 * "where": each hierarchy top-down inside the window. When a chain stops
 * because no child stands out, the change may still sit in a pocket the coarse
 * levels average away (children cancelling out, or one cell too small to move
 * a parent node), so sweep the deeper levels across all their nodes and resume the
 * chain from the first culprit found there.
 */
export async function hierarchyDrill(ctx: RunContext, stepId: string): Promise<void> {
  const params = windowParams(ctx);
  for (const [hierarchy, levels] of Object.entries(ctx.ontology.hierarchies)) {
    const found: Deepest[] = [];
    const first = await chain(ctx, stepId, hierarchy, levels, 0, undefined, 1);
    if (first.deepest) found.push(first.deepest);

    if (first.stop?.diluted) {
      for (let j = first.stop.index + 1; j < levels.length; j++) {
        const level = levels[j];
        const d = decomposeChildren(ctx, await ctx.tools.call(ctx.index.slice(ctx.metric, level), params, stepId));
        const dec = decide(ctx, d);
        ctx.path.push({
          level,
          node: dec.culprit ?? "(none)",
          decision: dec.decision,
          hierarchy,
          parent: "(all)",
          numbers: numbers(d, dec, dec.culprit ?? undefined),
        });
        addFlags(ctx, level, undefined, dec);
        // a pocket the coarse levels averaged away shows up here as a masked node (parent looked flat) or
        // as a node carrying most of a change that was real but too spread to see one level up
        if (!d || (dec.decision !== "masked" && dec.decision !== "drill") || !dec.culprit) continue;

        const child = d.children.find((c) => c.node === dec.culprit)!;
        const scale = child.cur.den / d.parent.cur.den;
        const swept: Deepest = {
          draft: {
            dimension: level,
            value: child.node,
            impact: dec.effect === "mix" ? child.mixEffect : child.contribution,
            effect: dec.effect,
            evidence: [stepId],
            persist: { col: level, value: child.node, base: child.base },
          },
          candidate: { hierarchy, level, node: child.node, base: child.base, scaleAfter: scale },
        };
        const resumed = await chain(ctx, stepId, hierarchy, levels, j + 1, child.node, scale);
        found.push(resumed.deepest ?? swept);
        break;
      }
    }
    for (const f of found) {
      ctx.drafts.push(f.draft);
      ctx.candidates.push(f.candidate);
    }
  }
}

/** Rank flat dimensions: across the whole window, or (refine) inside each drilled hierarchy node. */
export async function rankDimensions(ctx: RunContext, stepId: string, mode: "window" | "node"): Promise<void> {
  const params = windowParams(ctx);
  const targets = mode === "window" ? [undefined] : ctx.candidates;
  for (const cand of targets) {
    for (const dim of ctx.ontology.dimensions) {
      const tool = ctx.index.slice(ctx.metric, dim, cand ? [cand.level] : []);
      const callParams = cand ? { ...params, [cand.level]: cand.node } : params;
      const d = decomposeChildren(ctx, await ctx.tools.call(tool, callParams, stepId));
      const dec = decide(ctx, d);
      ctx.path.push({
        level: dim,
        node: dec.culprit ?? "(none)",
        decision: dec.decision,
        ...(cand ? { parent: `${cand.level}=${cand.node}` } : {}),
        numbers: numbers(d, dec, dec.culprit ?? undefined),
      });
      addFlags(ctx, dim, cand?.node, dec);
      if (!d || !dec.culprit) continue;
      const child = d.children.find((c) => c.node === dec.culprit)!;
      ctx.drafts.push({
        dimension: dim,
        value: child.node,
        impact: (dec.effect === "mix" ? child.mixEffect : child.contribution) * (cand?.scaleAfter ?? 1),
        effect: dec.effect,
        evidence: [stepId],
        ...(cand ? { scope: { [cand.level]: cand.node } } : {}),
        persist: cand ? { col: cand.level, value: cand.node, base: cand.base } : { col: dim, value: child.node, base: child.base },
      });
    }
  }
}

/**
 * Is each finding bad across the whole window, or in one slot? Re-reads the
 * finding's node (its scope node, when it has one) at the next-finer time level.
 */
export async function checkPersistence(ctx: RunContext, stepId: string): Promise<void> {
  const seasonal = ctx.slots.all.length > 0;
  if (ctx.kind === "sum" && !seasonal) return; // without declared seasonality, slot-by-slot comparison of a total is not meaningful
  const window: Window = need(ctx.window, "the drill window");
  const levels = ctx.ontology.time.levels;
  const persistLevel = levels[1] ?? levels[0];
  const adv = adverse(ctx);
  const period = need(ctx.period, "the period");
  for (const draft of ctx.drafts) {
    if (!draft.persist) continue; // time-slot findings are already localised in time
    if (draft.effect === "mix") continue; // a change in volume mix has no rate to persist
    const { col, value, base } = draft.persist;
    const rows = toBuckets(await ctx.tools.call(ctx.index.series(ctx.metric, persistLevel, [col]), { start: window.start, end: window.end, [col]: value }, stepId));
    // each bucket against the node's own baseline at the same place in the cycles, not a pooled rate
    const baseRows = seasonal ? toBuckets(await ctx.tools.call(ctx.index.series(ctx.metric, persistLevel, [col]), { start: period.base.start, end: period.base.end, [col]: value }, stepId)) : [];
    const judged = rows
      .filter((b) => b.den > 0)
      .map((b) => (seasonal ? { b, ...expectedFor(b, baseRows, ctx.slots.all) } : { b, base, matches: 1 }))
      .filter((x) => x.base !== null && x.base.den > 0);
    if (judged.length === 0) continue;
    const bad = judged.filter(({ b, base: e, matches }) => {
      if (ctx.kind === "sum") {
        const delta = b.num - e!.num / matches;
        return delta * adv > 0 && Math.abs(zSum(b, e!, 1 / matches)) >= ctx.th.onset_z;
      }
      const baseRate = rate(e!);
      return baseRate !== null && (b.num / b.den - baseRate) * adv > 0 && Math.abs(zScore(b, e!)) >= ctx.th.onset_z;
    });
    draft.persistence = bad.length / judged.length >= 0.5 ? "persistent" : "single_slot";
    draft.evidence = [...new Set([...draft.evidence, stepId])];
  }
}
