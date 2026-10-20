import { Result, type ToolsMeta, type Finding, type Generator, type Ontology, type Playbook, type SeasonalityNote } from "@causeline/schema";
import { round6, type FindingDraft, type RunContext } from "./context.js";
import { DEFAULT_THRESHOLDS, resolveThresholds } from "./masking.js";
import { slotNamesOf } from "./seasonal.js";
import { COMPUTE } from "./steps.js";
import { runProductMetric } from "./product.js";
import { LoggingToolCaller } from "./toolcaller.js";
import { ToolIndex } from "./toolindex.js";
import { VERSION } from "./version.js";
import { RunStop, type ToolCaller } from "./types.js";
import { parseScope, ScopedToolCaller } from "./scope.js";

export type RunInputs = Record<string, string | number | boolean>;

export interface RunOptions {
  playbook: Playbook;
  ontology: Ontology;
  tools: ToolCaller;
  /** What each generated tool answers (tools.meta.yaml). */
  meta: ToolsMeta;
  inputs: RunInputs;
  generator?: Generator;
}

/** Attribution carried in every result.json (see the build spec's attribution section). */
export function defaultGenerator(): Generator {
  return { name: "causeline", version: VERSION, url: "https://github.com/hprewa/causeline" };
}

function coerceInputs(playbook: Playbook, given: RunInputs): RunInputs {
  const out: RunInputs = { ...given };
  for (const [name, spec] of Object.entries(playbook.inputs)) {
    const raw = given[name] ?? spec.default;
    if (raw === undefined) throw new Error(`playbook "${playbook.name}" needs input "${name}"`);
    if (spec.type === "int" || spec.type === "float") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`input "${name}" must be a number, got "${raw}"`);
      out[name] = spec.type === "int" ? Math.trunc(n) : n;
    } else if (spec.type === "boolean") {
      out[name] = typeof raw === "boolean" ? raw : String(raw) === "true";
    } else {
      out[name] = String(raw);
    }
  }
  return out;
}

/** Threshold overrides can ride along as run inputs of the same name. */
function thresholdInputs(inputs: RunInputs) {
  const picked: Record<string, number> = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    if (inputs[key] !== undefined) picked[key] = Number(inputs[key]);
  }
  return picked;
}

/** How deep in its hierarchy a scope sits (top level = 0, next = 1), or -1 when it is not in one. */
function scopeDepth(scope: Record<string, string>, hierarchies: Record<string, string[]>): { hierarchy: string; depth: number } | null {
  const [level] = Object.keys(scope);
  for (const [name, levels] of Object.entries(hierarchies)) {
    const i = levels.indexOf(level);
    if (i >= 0) return { hierarchy: name, depth: i };
  }
  return null;
}

/**
 * Merge raw findings into a ranked list. A dimension value found inside a
 * drilled node supersedes the same value found network-wide (it is the more
 * specific explanation); more specific findings rank first, then by impact.
 * Likewise, the same value found inside a node and inside a deeper node of the same
 * hierarchy, with the deeper one carrying nearly all of the impact, is one finding:
 * the deeper node is where it is.
 */
function rankFindings(drafts: FindingDraft[], metric: string, hierarchies: Record<string, string[]>): Finding[] {
  const scoped = drafts.filter((d) => d.scope);
  let kept = drafts.filter((d) => {
    if (d.scope) return true;
    const twin = scoped.filter((s) => s.dimension === d.dimension && s.value === d.value);
    for (const s of twin) s.evidence = [...new Set([...d.evidence, ...s.evidence])];
    return twin.length === 0;
  });
  kept = kept.filter((d) => {
    if (!d.scope) return true;
    const mine = scopeDepth(d.scope, hierarchies);
    if (!mine) return true;
    const deeper = kept.filter((o) => {
      if (o === d || !o.scope || o.dimension !== d.dimension || o.value !== d.value) return false;
      const theirs = scopeDepth(o.scope, hierarchies);
      return !!theirs && theirs.hierarchy === mine.hierarchy && theirs.depth > mine.depth && Math.abs(o.impact) >= 0.7 * Math.abs(d.impact);
    });
    for (const o of deeper) o.evidence = [...new Set([...d.evidence, ...o.evidence])];
    return deeper.length === 0;
  });
  kept.sort((a, b) => Number(!!b.scope) - Number(!!a.scope) || Math.abs(b.impact) - Math.abs(a.impact));
  return kept.map((d, i) => ({
    rank: i + 1,
    dimension: d.dimension,
    value: d.value,
    impact: round6(d.impact) ?? 0,
    metric,
    evidence: d.evidence,
    ...(d.scope ? { scope: d.scope } : {}),
    ...(d.effect ? { effect: d.effect } : {}),
    ...(d.persistence ? { persistence: d.persistence } : {}),
  }));
}

function seasonalityNote(ctx: RunContext): SeasonalityNote {
  if (ctx.slots.all.length === 0) return { status: "none_declared", cycles: [], calendar: [], baseline: "pooled", notes: [...new Set(ctx.seasonNotes)] };
  const fellBack = ctx.period?.notes.some((n) => n.startsWith("fewer than two")) ?? false;
  return {
    status: "applied",
    cycles: ctx.slots.all.filter((n) => !ctx.slots.calendar.includes(n)),
    calendar: ctx.slots.calendar,
    baseline: fellBack ? "pooled" : "like_for_like",
    notes: [...new Set(ctx.seasonNotes)],
  };
}

export async function runPlaybook(given: RunOptions): Promise<Result> {
  const inputs = coerceInputs(given.playbook, given.inputs);
  // a scope confines every query to one value of one or more concepts; a product's recursive runs share the wrapper
  const scope = parseScope(inputs.scope);
  const opts: RunOptions = Object.keys(scope).length > 0 && !(given.tools instanceof ScopedToolCaller) ? { ...given, tools: new ScopedToolCaller(given.tools, given.meta, scope) } : given;
  const { playbook, ontology } = opts;
  const metric = String(inputs.metric);
  const def = ontology.metrics[metric];
  if (!def) throw new Error(`metric "${metric}" is not in the ontology (have: ${Object.keys(ontology.metrics).join(", ")})`);
  const th = resolveThresholds(ontology.thresholds, thresholdInputs(inputs));
  const generator = opts.generator ?? defaultGenerator();

  // a product is analysed through its drivers; the dominant one is run as a metric of its own
  if (def.type === "product" && !playbook.steps.some((s) => s.compute === "guided_drill")) {
    // value, trend and compare are built on a ratio or a total; a product is only analysed through its drivers
    return Result.parse({
      playbook: playbook.name,
      inputs,
      status: "stopped",
      headline: null,
      findings: [],
      stopped_reason: "product_not_supported",
      stopped_detail: `"${metric}" is a product of ${def.drivers.join(" and ")}; ask about its drivers, or ask why it changed`,
      generator,
    });
  }
  if (def.type === "product") {
    try {
      const r = await runProductMetric({
        playbook,
        ontology,
        tools: opts.tools,
        index: new ToolIndex(opts.meta),
        inputs,
        metric,
        def,
        th,
        generator,
        recurse: (next) => runPlaybook({ ...opts, inputs: next }),
      });
      const cost = opts.tools.cost?.();
      return cost ? { ...r, cost } : r;
    } catch (e) {
      if (!(e instanceof RunStop)) throw e;
      return Result.parse({ playbook: playbook.name, inputs, status: "stopped", headline: null, findings: [], stopped_reason: e.reason, stopped_detail: e.detail, generator, ...(opts.tools.cost?.() ? { cost: opts.tools.cost?.() } : {}) });
    }
  }

  const tools = new LoggingToolCaller(opts.tools);
  const ctx: RunContext = {
    ontology,
    metric,
    kind: def.type,
    sumScale: 1,
    slots: slotNamesOf(ontology),
    slotFilter: {},
    seasonNotes: [],
    minVolume: def.min_volume,
    direction: def.direction,
    th,
    tools,
    index: new ToolIndex(opts.meta),
    inputs,
    path: [],
    flags: [],
    drafts: [],
    evidence: [],
    candidates: [],
    looks: [],
    contributions: [],
    stepKinds: new Map(),
  };

  for (const step of playbook.steps) {
    const name = step.evidence ? "evidence" : step.compute!;
    const fn = COMPUTE[name];
    if (!fn) throw new Error(`step "${step.id}" uses unknown compute "${name}" (have: ${Object.keys(COMPUTE).join(", ")})`);
    ctx.stepKinds.set(step.id, { compute: name, over: step.over });
    try {
      await fn(ctx, step);
    } catch (e) {
      if (!(e instanceof RunStop)) throw e;
      ctx.stop = { reason: e.reason, detail: e.detail };
    }
    if (ctx.stop) break;
  }

  return Result.parse({
    playbook: playbook.name,
    inputs,
    status: ctx.stop ? "stopped" : "complete",
    ...(ctx.window ? { window: ctx.window } : {}),
    onset: ctx.onset ?? null,
    headline: ctx.headline ?? null,
    seasonality: seasonalityNote(ctx),
    ...(ctx.trend ? { trend: ctx.trend } : {}),
    ...(ctx.comparison ? { comparison: ctx.comparison } : {}),
    findings: ctx.stop ? [] : rankFindings(ctx.drafts, metric, ontology.hierarchies),
    contributions: ctx.stop ? [] : ctx.contributions,
    ...(ctx.explained && !ctx.stop ? { explained: ctx.explained } : {}),
    evidence: ctx.stop ? [] : ctx.evidence,
    path: ctx.path,
    masking_flags: ctx.flags,
    steps: tools.log,
    stopped_reason: ctx.stop?.reason ?? null,
    stopped_detail: ctx.stop?.detail ?? null,
    ...(opts.tools.cost?.() ? { cost: opts.tools.cost?.() } : {}),
    narrative: null,
    generator,
  });
}
