import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultPlaybooksDir, loadPlaybook, runPlaybook, toBuckets, ToolIndex, type Bucket, type ToolCaller } from "@causeline/runner";
import { loadAgents, loadPack, type Route } from "@causeline/schema";
import { route } from "./router.js";

/** Names of the playbooks that exist for a pack: its own, then the core's. */
export function playbookNames(packDir: string, coreDir: string = defaultPlaybooksDir()): string[] {
  const names = new Set<string>();
  for (const dir of [join(packDir, "playbooks"), coreDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".yaml")) names.add(f.slice(0, -5));
  }
  return [...names];
}

/**
 * The complete buckets of the top time level, oldest first. A final bucket with far fewer rows than the
 * one before is still being filled in and is left out, so "last week" means the last whole one.
 */
export async function completeBuckets(tools: ToolCaller, index: ToolIndex, metric: string, level: string): Promise<Bucket[]> {
  const counts = (await tools.call(index.extent(metric), {}, "route"))[0];
  const series = toBuckets(await tools.call(index.series(metric, level), { start: String(counts.min_ts), end: String(counts.max_ts) }, "route"));
  const last = series[series.length - 1];
  const before = series[series.length - 2];
  return last && before && last.den < 0.6 * before.den ? series.slice(0, -1) : series;
}

/** The labels of the complete periods of the top time level, oldest first. */
export async function completePeriods(tools: ToolCaller, index: ToolIndex, metric: string, level: string): Promise<string[]> {
  return (await completeBuckets(tools, index, metric, level)).map((b) => b.bucket);
}

export interface RouteWithDataOptions {
  packDir: string;
  question: string;
  tools: ToolCaller;
  corePlaybooksDir?: string;
  /** Period labels already read (a batch of questions reads them once). */
  periods?: string[];
}

/** The router with what it needs from the pack and its data: the period labels, and (for a comparison) the values of each concept. */
export async function routeWithData(opts: RouteWithDataOptions): Promise<Route> {
  const pack = loadPack(opts.packDir, { requireMeta: true });
  const index = new ToolIndex(pack.meta!);
  const metric = Object.keys(pack.data.metrics)[0];
  const level = pack.ontology.time.levels[0];
  const periods = opts.periods ?? (await completePeriods(opts.tools, index, metric, level));
  const input = { question: opts.question, ontology: pack.ontology, agents: loadAgents(opts.packDir), playbooks: playbookNames(opts.packDir, opts.corePlaybooksDir), periods };

  const first = route(input);
  // values of each concept are only needed to recognise "A versus B"; fetch them just for a comparison with no two periods
  if (first.options[0]?.task !== "compare" || first.options[0].inputs.against !== undefined || first.options[0].inputs.concept !== undefined) return first;
  const window = { start: "", end: "" };
  const counts = (await opts.tools.call(index.extent(metric), {}, "route"))[0];
  window.start = String(counts.min_ts);
  window.end = String(counts.max_ts);
  const members: Record<string, string[]> = {};
  const concepts = [...Object.values(pack.ontology.hierarchies).flat(), ...pack.ontology.dimensions];
  for (const concept of concepts) {
    const rows = await opts.tools.call(index.slice(metric, concept), { cur_start: window.start, cur_end: window.end, base_start: window.start, base_end: window.end }, "route");
    members[concept] = rows.map((r) => String(r.node)).slice(0, 200);
  }
  return route({ ...input, members });
}

export interface ScanResult {
  period: string;
  kpis: { kpi: string; value: number; expected: number; change: number; z: number; moved: boolean; adverse: boolean | null }[];
  /** KPIs that moved significantly, worst first (adverse moves before favourable ones, then by size). */
  moved: string[];
  skipped: { kpi: string; reason: string }[];
}

/**
 * Check every KPI for a period against what it should have been (the same like-for-like headline the
 * runner computes) and say which moved. The first step of a vague question: the ones that moved are
 * worth a deep dive; the rest are fine.
 */
export async function scanKpis(opts: { packDir: string; period: string; tools: ToolCaller; corePlaybooksDir?: string }): Promise<ScanResult> {
  const pack = loadPack(opts.packDir, { requireMeta: true });
  const playbook = loadPlaybook("value", opts.packDir, opts.corePlaybooksDir);
  const out: ScanResult = { period: opts.period, kpis: [], moved: [], skipped: [] };
  for (const [kpi, def] of Object.entries(pack.ontology.metrics)) {
    if (def.type === "product") {
      out.skipped.push({ kpi, reason: "a product of other KPIs; its drivers are checked on their own" });
      continue;
    }
    const r = await runPlaybook({ playbook, ontology: pack.ontology, meta: pack.meta!, tools: opts.tools, inputs: { metric: kpi, period: opts.period } });
    if (!r.headline) {
      out.skipped.push({ kpi, reason: r.stopped_detail ?? r.stopped_reason ?? "no result" });
      continue;
    }
    const h = r.headline;
    const worseWhenLower = def.direction === "higher_is_better";
    out.kpis.push({
      kpi,
      value: h.value,
      expected: h.baseline,
      change: h.change,
      z: h.z ?? 0,
      moved: h.significant === true,
      adverse: h.significant ? (h.change < 0) === worseWhenLower : null,
    });
  }
  out.moved = out.kpis
    .filter((k) => k.moved)
    .sort((a, b) => Number(b.adverse === true) - Number(a.adverse === true) || Math.abs(b.z) - Math.abs(a.z))
    .map((k) => k.kpi);
  return out;
}
