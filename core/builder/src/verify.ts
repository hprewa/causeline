import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { runEvals } from "@causeline/eval";
import { resolvePeriods } from "@causeline/router";
import { toBuckets, ToolIndex, type ToolCaller } from "@causeline/runner";
import { AgentDef, EvalCases, loadAgents, loadPack } from "@causeline/schema";
import { adoptConfirmed, normaliseExpected } from "./checks.js";
import { atLeast } from "@causeline/schema";
import { syncExperts } from "./checks.js";
import { levelGap, levelOf, logChange, readState, updateState, type Level } from "./state.js";

export interface Reconciliation {
  kpi: string;
  period: string;
  expected: number;
  got: number;
  /** Relative difference allowed. */
  tolerance: number;
  match: boolean;
  /** What to look at when it does not match. */
  hints: string[];
  /** Where the KPI stands on the ladder afterwards, and what stands between it and the next step. */
  level?: Level;
  gap?: string;
}

/**
 * The one-number path: compute a KPI for one whole period through the generated tools and compare it with a number
 * the user already knows. A match is stored as a confirmed `total` check, one of the three numbers (from two periods and
 * two kinds) the first rung asks for (see `proposeChecks` and `confirmNumber`).
 */
export async function reconcileMetric(opts: { workspace: string; kpi: string; period: string; expected: number; tolerance?: number; source?: string; tools: ToolCaller }): Promise<Reconciliation> {
  const pack = loadPack(opts.workspace, { requireMeta: true });
  const def = pack.ontology.metrics[opts.kpi];
  if (!def) throw new Error(`"${opts.kpi}" is not a KPI in this pack (have: ${Object.keys(pack.ontology.metrics).join(", ")})`);
  if (def.type === "product") throw new Error(`${opts.kpi} is a product of other KPIs; reconcile its parts (${def.drivers.join(", ")})`);
  const index = new ToolIndex(pack.meta!);
  const level = pack.ontology.time.levels[0];
  const counts = (await opts.tools.call(index.extent(opts.kpi), {}, "reconcile"))[0];
  const series = toBuckets(await opts.tools.call(index.series(opts.kpi, level), { start: String(counts.min_ts), end: String(counts.max_ts) }, "reconcile"));
  const all = series.map((b) => b.bucket);
  const resolved = all.includes(opts.period) ? opts.period : resolvePeriods(opts.period, all, level)[0];
  if (!resolved) throw new Error(`period "${opts.period}" not found; available: ${all[0]} .. ${all[all.length - 1]}`);

  const bucket = series.find((b) => b.bucket === resolved)!;
  const got = def.type === "sum" ? bucket.num : bucket.den > 0 ? bucket.num / bucket.den : NaN;
  const expected = normaliseExpected(opts.expected, def.type === "ratio", got);
  const tolerance = opts.tolerance ?? 0.01;
  const match = Number.isFinite(got) && Math.abs(got - expected) <= tolerance * Math.abs(expected);
  const hints: string[] = [];
  if (!match) {
    hints.push(`the data gives ${got} for ${resolved} and you expected ${expected}: a difference of ${Math.round(((got - expected) / (expected || 1)) * 1000) / 10}%`);
    hints.push(`check which date decides the period (this uses ${pack.data.facts[pack.data.metrics[opts.kpi].fact].time}) and whether your report uses calendar weeks starting on the same day`);
    hints.push("check what is counted: a filter your report applies (cancelled orders, test accounts), and whether a join drops or repeats rows");
  }
  const result: Reconciliation = { kpi: opts.kpi, period: resolved, expected, got, tolerance, match, hints };
  if (match) {
    const d = await adoptConfirmed({ workspace: opts.workspace, kpi: opts.kpi, kind: "total", window: { start: bucket.bucket_start.slice(0, 10), end: bucket.bucket_end.slice(0, 10) }, expected, got, tolerance, source: opts.source?.trim() || "the user's own report", tools: opts.tools });
    result.level = d.level;
    result.gap = d.gap;
  }
  return result;
}

export interface IncidentInput {
  workspace: string;
  kpi: string;
  /** The period label (or words like "week 10"; the agent resolves it with route first). Leave empty when the incident is given as dates. */
  period: string;
  /** The incident as whole days, both inclusive (YYYY-MM-DD), for data whose periods are not labelled the way people say them. */
  start_date?: string;
  end_date?: string;
  /** Where the user knows it was: the concept and value, and where inside what (a value of a concept, optionally inside a value of another). */
  finding: { dimension: string; value: string; scope?: Record<string, string> };
  /** The question as the user would ask it. */
  question: string;
  /** The analysis must report it among its findings, not necessarily first (when another finding describes the same records another way and can tie for first). Default: it must be first. */
  anywhere?: boolean;
  /** Words the cause records or the answer should contain (for example "hub outage"). */
  mention?: string[];
  /** Keep it aside: looked at only when the expert is checked, never to adjust anything. Default: kept aside once the KPI already has another incident. */
  held_out?: boolean;
}

/**
 * Remember a past incident the user knows the answer to as an eval case against their real data. It is run by the
 * same runner and scored by the same scorer as every other case.
 */
export function addIncident(opts: IncidentInput): { id: string; file: string; held_out: boolean } {
  const pack = loadPack(opts.workspace);
  if (!pack.ontology.metrics[opts.kpi]) throw new Error(`"${opts.kpi}" is not a KPI in this pack`);
  const concepts = [...Object.values(pack.ontology.hierarchies).flat(), ...pack.ontology.dimensions];
  for (const c of [opts.finding.dimension, ...Object.keys(opts.finding.scope ?? {})]) if (!concepts.includes(c)) throw new Error(`"${c}" is not something this pack can break a KPI down by (have: ${concepts.join(", ")})`);
  const state = readState(opts.workspace);
  if (!state) throw new Error("this workspace has not been set up yet");
  const folder = join(opts.workspace, "evals");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "cases.yaml");
  const existing = existsSync(file) ? (parse(readFileSync(file, "utf-8")) as unknown[]) : [];
  if (!opts.period && !(opts.start_date && opts.end_date)) throw new Error("say when it happened: a period, or a start and end date");
  const id = `incident_${state.incidents.length + 1}_${opts.kpi}`;
  const playbook = loadAgents(opts.workspace).find((a) => a.kpi === opts.kpi && a.task === "deep_rca")?.playbook ?? "metric_change";
  const c = {
    id,
    question: opts.question,
    inputs: { metric: opts.kpi, period: opts.period, playbook, ...(opts.start_date && opts.end_date ? { more: { start_date: opts.start_date, end_date: opts.end_date } } : {}) },
    expect: { ...(opts.anywhere ? { findings_include: [opts.finding] } : { top_finding: opts.finding }), ...(opts.mention?.length ? { must_mention: opts.mention } : {}) },
  };
  const cases = EvalCases.parse([...existing, c]);
  writeFileSync(file, stringify(cases, { lineWidth: 0 }), "utf-8");
  const held_out = opts.held_out ?? state.incidents.filter((i) => i.kpi === opts.kpi).length >= 1;
  updateState(opts.workspace, (s) => {
    s.incidents.push({ id, kpi: opts.kpi, text: opts.question, held_out });
  });
  return { id, file, held_out };
}

export interface Verification {
  kpi: string;
  /** True only when the KPI has also been calibrated, so the expert is verified in the full sense. */
  verified: boolean;
  /** Where the expert stands now. */
  level?: Level;
  reasons: string[];
  cases: { id: string; pass: boolean; detail: string; held_out: boolean }[];
  /** Recorded incidents found out of all recorded, and the same for the ones kept aside. */
  hit_rate?: number;
  held_out?: { passed: number; total: number };
}

/**
 * Replay the incidents the person recorded through the analysis. Needs a reconciled KPI (its numbers match the person's reports), at least
 * one recorded incident, and every incident case to pass through the runner. A pass is stored on the KPI as its incident check; it makes
 * the expert `verified` only once the KPI has also been calibrated (stays quiet over ordinary periods), so until then the expert stands
 * where its KPI stands and the result says what is still missing.
 */
export async function verifyExpert(opts: { workspace: string; kpi: string; toolbox?: string; corePlaybooksDir?: string }): Promise<Verification> {
  const state = readState(opts.workspace);
  const reasons: string[] = [];
  if (!state) throw new Error("this workspace has not been set up yet");
  const rec = state.kpis[opts.kpi];
  if (!atLeast(levelOf(rec), "reconciled")) reasons.push(`${opts.kpi} is not reconciled yet (it is ${levelOf(rec)}): ${levelGap(rec)}`);
  const mine = state.incidents.filter((i) => i.kpi === opts.kpi);
  if (mine.length === 0) reasons.push(`no past incident is recorded for ${opts.kpi}; record one you know the cause of`);
  if (reasons.length > 0) return { kpi: opts.kpi, verified: false, reasons, cases: [] };

  const outcomes = await runEvals({ packDir: opts.workspace, only: mine.map((i) => i.id), workRoot: join(opts.workspace, "runs", "verify"), reuse: false, toolbox: opts.toolbox, corePlaybooksDir: opts.corePlaybooksDir });
  const aside = new Set(mine.filter((i) => i.held_out).map((i) => i.id));
  const cases = outcomes.map((o) => ({ id: o.id, held_out: aside.has(o.id), pass: "pass" in o.runner && o.runner.pass, detail: "checks" in o.runner ? o.runner.checks.filter((c) => !c.ok).map((c) => c.detail ?? c.name).join("; ") : o.runner.error }));
  const found = cases.filter((c) => c.pass);
  const allFound = cases.length > 0 && found.length === cases.length;
  const heldFound = found.filter((c) => c.held_out).map((c) => c.id);
  const tuningFound = found.filter((c) => !c.held_out).map((c) => c.id);
  const heldTotal = cases.filter((c) => c.held_out).length;
  const hit_rate = cases.length > 0 ? found.length / cases.length : 0;
  const faultsKept = rec?.verification?.faults_passed ?? [];
  const faultsClear = (rec?.verification?.faults_total ?? 0) > 0 && faultsKept.length === rec!.verification!.faults_total;
  // proof the analysis finds what it was not set up on: a kept-aside incident found, or faults planted in the person's own data found
  const independent = allFound && (heldFound.length > 0 || faultsClear);
  const aboutHeldOut = { passed: heldFound.length, total: heldTotal };

  // keep what was found and how often; a miss takes verification away (an expert that stops finding what it found is not verified)
  const level = (() => {
    const out = { level: "draft" as Level };
    updateState(opts.workspace, (s) => {
      const k = s.kpis[opts.kpi];
      const before = levelOf(k);
      k.verification = { at: new Date().toISOString(), pass: independent, incidents_passed: found.map((c) => c.id), held_out_passed: heldFound, tuning_passed: tuningFound, hit_rate, ...(faultsKept.length > 0 || rec?.verification?.faults_total ? { faults_passed: faultsKept, faults_total: rec?.verification?.faults_total } : {}) };
      k.level = levelOf(k);
      out.level = k.level;
      logChange(s, `kpi:${opts.kpi}`, before, out.level, independent ? `the incident${heldFound.length === 1 ? "" : "s"} kept aside (${heldFound.join(", ")}) ${heldFound.length === 1 ? "was" : "were"} found` : allFound ? "the recorded incidents were found, but none was kept aside" : `${cases.length - found.length} of ${cases.length} recorded incidents were not found`, "verify_expert");
    });
    return out.level;
  })();
  if (!allFound) {
    return {
      kpi: opts.kpi,
      verified: false,
      level,
      hit_rate,
      held_out: aboutHeldOut,
      cases: cases.map((c) => (c.held_out && !c.pass ? { ...c, detail: "what was found instead is not shown" } : c)),
      // an incident kept aside is not explained: the person would be tempted to bend the analysis to fit it
      reasons: cases.filter((c) => !c.pass).map((c) => (c.held_out ? `${c.id} (kept aside) was not found; what the analysis said instead is not shown, so it cannot be adjusted to fit` : `${c.id} did not find what you said happened: ${c.detail}`)),
    };
  }

  // the expert exists at its KPI's rung once its incidents are found
  const existing = loadAgents(opts.workspace).find((a) => a.kpi === opts.kpi && a.task === "deep_rca");
  const agent = AgentDef.parse({ ...(existing ?? { name: `${opts.kpi.replace(/_/g, "-")}-deep-rca`, kpi: opts.kpi, task: "deep_rca", examples: mine.map((i) => i.text) }), status: existing?.status ?? "draft", ladder: 2 });
  mkdirSync(join(opts.workspace, "agents"), { recursive: true });
  writeFileSync(join(opts.workspace, "agents", `${agent.name}.yaml`), stringify(agent, { lineWidth: 0 }), "utf-8");
  syncExperts(opts.workspace, opts.kpi, level, `the recorded incident check ${independent ? "passed" : "found its incidents"} and its KPI is ${level}`, "verify_expert");
  const stillNeeds: string[] = [];
  if (!independent) stillNeeds.push(`it found ${cases.length === 1 ? "the incident" : "the incidents"} you recorded, but ${cases.length === 1 ? "that one was" : "none was"} kept aside while the analysis was set up, so it is not independent proof: record another incident and keep it aside, or plant faults in your own data`);
  if (level !== "verified") stillNeeds.push(`the incident check ran, and ${opts.kpi} stands as ${level}: ${levelGap(readState(opts.workspace)!.kpis[opts.kpi])}`);
  return { kpi: opts.kpi, verified: level === "verified", reasons: stillNeeds, cases, level, hit_rate, held_out: aboutHeldOut };
}
