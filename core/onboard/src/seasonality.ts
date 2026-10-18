import { BUILTIN_SLOTS, type DataDefs, type Ontology } from "@causeline/schema";
import { candidateCycles } from "@causeline/generate";
import { type ResolvedThresholds, type ToolCaller, type ToolIndex } from "@causeline/runner";
import { chi2Survival } from "./chi2.js";

export type CycleStatus = "seasonal" | "not_seasonal" | "cannot_assess";

export interface SlotStat {
  slot: string;
  /** Occurrences of this position in the data (days, or hours, that fall in it). */
  instances: number;
  /** Mean of the metric at this position: a rate, an average, or the mean total per occurrence. */
  mean: number;
}

export interface CycleResult {
  metric: string;
  cycle: string;
  kind: "cycle" | "calendar";
  status: CycleStatus;
  /** Why, in a sentence a person can read. */
  reason: string;
  /** Fewest occurrences of any tested position: the history the verdict rests on. */
  repeats: number;
  slots: SlotStat[];
  chi2?: number;
  df?: number;
  p?: number;
  /** Share of the variation explained by the position (0..1). */
  eta2?: number;
  /** (highest position - lowest position) / |overall level|. */
  amplitude?: number;
  peak?: string;
  trough?: string;
}

export interface SeasonalityAnalysis {
  results: CycleResult[];
  /** The block to put in `time.seasonality`, from what was found. */
  recommended: { cycles: string[]; calendar: string[]; none: boolean };
  /** Cycles the ontology declares that were not detected, and detected cycles it does not declare. */
  declared: { confirmed: string[]; unsupported: string[]; missing: string[] };
  notes: string[];
}

const NUMBER = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Positions with fewer rows (or occurrences) than this are too thin to carry a verdict. */
const MIN_ROWS = 30;
const MIN_INSTANCES = 2;

/**
 * Is a metric different at different positions of a cycle? One-way analysis of variance on the
 * positions, as a chi-square: the between-position sum of squares over the within-position variance.
 * Rows are the sample for a rate or an average, occurrences (days, hours) for a total, because a
 * total's variability is between occurrences, not between rows. Both conditions must hold for
 * "seasonal": the pattern is real (p) and big enough to matter (amplitude).
 */
export function testCycle(
  metric: string,
  cycle: string,
  kind: "cycle" | "calendar",
  type: "ratio" | "sum",
  rows: { slot: string; instances: number; num: number; den: number; sq: number }[],
  th: Pick<ResolvedThresholds, "season_p" | "season_amplitude" | "season_min_repeats">,
): CycleResult {
  // effective count c, sum x and sum of squares q, per position
  const cells = rows
    .map((r) => (type === "ratio" ? { slot: r.slot, instances: r.instances, c: r.den, x: r.num, q: r.sq } : { slot: r.slot, instances: r.instances, c: r.instances, x: r.num, q: r.sq }))
    .filter((r) => r.c > 0);
  const slots: SlotStat[] = cells.map((r) => ({ slot: r.slot, instances: r.instances, mean: r.x / r.c }));
  const base = { metric, cycle, kind, slots };

  if (cells.length < 2) {
    return { ...base, status: "cannot_assess", repeats: cells[0]?.instances ?? 0, reason: "the data has only one position in this cycle (the time column may not carry it)" };
  }
  const repeats = Math.min(...cells.map((r) => r.instances));
  if (repeats < th.season_min_repeats) {
    return {
      ...base,
      status: "cannot_assess",
      repeats,
      reason: `the data holds at most ${repeats} occurrence${repeats === 1 ? "" : "s"} of its thinnest position, and ${th.season_min_repeats} are needed to judge a cycle; this is reported, not tested`,
    };
  }
  const thick = cells.filter((r) => (type === "ratio" ? r.c >= MIN_ROWS : r.instances >= MIN_INSTANCES));
  if (thick.length < 2) return { ...base, status: "cannot_assess", repeats, reason: "too few rows at each position to compare them" };

  const N = thick.reduce((a, r) => a + r.c, 0);
  const X = thick.reduce((a, r) => a + r.x, 0);
  const Q = thick.reduce((a, r) => a + r.q, 0);
  const K = thick.length;
  const grand = X / N;
  const ssb = thick.reduce((a, r) => a + r.c * (r.x / r.c - grand) ** 2, 0);
  const sst = Math.max(0, Q - (X * X) / N);
  const ssw = Math.max(0, sst - ssb);
  const sigma2 = N > K ? ssw / (N - K) : 0;
  const means = thick.map((r) => r.x / r.c);
  const hi = Math.max(...means);
  const lo = Math.min(...means);
  const amplitude = grand === 0 ? (hi === lo ? 0 : Infinity) : (hi - lo) / Math.abs(grand);
  const chi2 = sigma2 > 0 ? ssb / sigma2 : ssb > 0 ? Infinity : 0;
  const p = Number.isFinite(chi2) ? chi2Survival(chi2, K - 1) : 0;
  const eta2 = sst > 0 ? ssb / sst : 0;
  const peak = thick[means.indexOf(hi)].slot;
  const trough = thick[means.indexOf(lo)].slot;
  const stats = { chi2, df: K - 1, p, eta2, amplitude, peak, trough, repeats };

  const real = p < th.season_p;
  const big = amplitude >= th.season_amplitude;
  const pv = (p: number) => (p === 0 ? "<1e-300" : p.toExponential(1));
  const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "unbounded");
  if (real && big) {
    return { ...base, ...stats, status: "seasonal", reason: `positions differ (p=${pv(p)}) by ${pct(amplitude)} of the overall level, highest at ${peak}, lowest at ${trough}` };
  }
  return {
    ...base,
    ...stats,
    status: "not_seasonal",
    reason: real
      ? `positions differ (p=${pv(p)}) but only by ${pct(amplitude)} of the overall level, under the ${pct(th.season_amplitude)} that matters`
      : `no reliable difference between positions (p=${pv(p)}; spread ${pct(amplitude)})`,
  };
}

export interface AnalyseOptions {
  ontology: Ontology;
  data: DataDefs;
  tools: ToolCaller;
  /** Finds the seasonal-profile tools by what they answer. */
  index: ToolIndex;
  th: ResolvedThresholds;
  /** Time extent of the data, from row_counts. */
  extent: { start: string; end: string };
  /** Limit the analysis to these metrics (default: every ratio and sum metric). */
  metrics?: string[];
}

/** Test every candidate cycle for every metric, and recommend a `time.seasonality` block. */
export async function analyseSeasonality(opts: AnalyseOptions): Promise<SeasonalityAnalysis> {
  const { ontology, data, tools, index, th } = opts;
  const metrics = Object.entries(ontology.metrics).filter(([name, m]) => m.type !== "product" && (!opts.metrics || opts.metrics.includes(name)));
  const results: CycleResult[] = [];
  for (const [metric, def] of metrics) {
    for (const cand of candidateCycles(ontology, data, data.metrics[metric].fact)) {
      const rows = await tools.call(index.profile(metric, cand.name), { start: opts.extent.start, end: opts.extent.end }, "onboarding");
      results.push(
        testCycle(
          metric,
          cand.name,
          cand.kind,
          def.type as "ratio" | "sum",
          rows.map((r) => ({ slot: String(r.slot ?? ""), instances: NUMBER(r.instances), num: NUMBER(r.num), den: NUMBER(r.den), sq: NUMBER(r.sq) })),
          th,
        ),
      );
    }
  }
  return summarise(ontology, results);
}

/** Roll the per-metric verdicts up into a recommendation. A cycle is recommended if any metric is seasonal in it. */
export function summarise(ontology: Ontology, results: CycleResult[]): SeasonalityAnalysis {
  const notes: string[] = [];
  const seasonal = new Set(results.filter((r) => r.kind === "cycle" && r.status === "seasonal").map((r) => r.cycle));

  // a finer cycle that repeats a coarser one adds nothing unless it explains clearly more
  const eta = (cycle: string) => Math.max(0, ...results.filter((r) => r.cycle === cycle && r.status === "seasonal").map((r) => r.eta2 ?? 0));
  if (seasonal.has("hour_of_day") && seasonal.has("half_hour_of_day") && eta("half_hour_of_day") < 1.25 * eta("hour_of_day")) {
    seasonal.delete("half_hour_of_day");
    notes.push("half_hour_of_day is seasonal but explains no more than hour_of_day, so it is left out as redundant");
  }

  const long = results.filter((r) => r.kind === "cycle" && r.status === "cannot_assess" && (r.cycle === "month_of_year" || r.cycle === "day_of_month"));
  for (const name of new Set(long.map((r) => r.cycle))) {
    const repeats = Math.max(...long.filter((r) => r.cycle === name).map((r) => r.repeats));
    notes.push(`${name} cannot be assessed: the history holds ${repeats} occurrence(s) of each position. It is reported, not tested, and not applied`);
  }
  const unseen = results.filter((r) => r.kind === "calendar" && r.status === "cannot_assess");
  for (const name of new Set(unseen.map((r) => r.cycle))) {
    const why = unseen.find((r) => r.cycle === name)!.reason;
    notes.push(`calendar flag ${name}: ${why}; it is kept so that flagged days are compared only with flagged days`);
  }

  // built-in positions in their usual order, then any the pack defines itself
  const cycles: string[] = [...BUILTIN_SLOTS.filter((b) => seasonal.has(b)), ...[...seasonal].filter((n) => !(BUILTIN_SLOTS as readonly string[]).includes(n))];

  // a calendar flag is two-valued (a holiday, a peak); a candidate with more positions is a cycle in disguise
  const flags = [...new Set(results.filter((r) => r.kind === "calendar").map((r) => r.cycle))];
  const positions = (col: string) => Math.max(0, ...results.filter((r) => r.cycle === col).map((r) => r.slots.length));
  const calendar = flags.filter((col) => positions(col) <= 2);
  for (const col of flags.filter((c) => positions(c) > 2)) {
    notes.push(`${col} has ${positions(col)} distinct values, so it is not a calendar flag; declare it as a cycle if it is seasonal`);
  }

  const declared = ontology.time.seasonality === "none" ? [] : ontology.time.seasonality.cycles;
  const names = new Set(cycles);
  return {
    results,
    recommended: { cycles, calendar, none: cycles.length === 0 && calendar.length === 0 },
    declared: {
      confirmed: declared.filter((d) => names.has(d)),
      unsupported: declared.filter((d) => !names.has(d)),
      missing: [...names].filter((n) => !declared.includes(n)),
    },
    notes,
  };
}
