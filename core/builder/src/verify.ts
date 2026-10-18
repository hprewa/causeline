import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { runEvals } from "@causeline/eval";
import { resolvePeriods } from "@causeline/router";
import { toBuckets, ToolIndex, type ToolCaller } from "@causeline/runner";
import { AgentDef, EvalCases, loadAgents, loadPack } from "@causeline/schema";
import { readState, updateState } from "./state.js";

/** A person says 93.1 and means 93.1%; a fraction is stored as 0.931. */
export function normaliseExpected(expected: number, isRate: boolean, observed: number): number {
  return isRate && observed > 0 && observed <= 1 && expected > 1 && expected <= 100 ? Math.round(expected * 1e7) / 1e9 : expected;
}

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
}

/**
 * Compute a KPI for a period through the generated tools and compare it with a number the user already knows
 * (from their own report). A match marks the KPI reconciled; nothing else does.
 */
export async function reconcileMetric(opts: { workspace: string; kpi: string; period: string; expected: number; tolerance?: number; tools: ToolCaller }): Promise<Reconciliation> {
  const pack = loadPack(opts.workspace, { requireMeta: true });
  const def = pack.ontology.metrics[opts.kpi];
  if (!def) throw new Error(`"${opts.kpi}" is not a KPI in this pack (have: ${Object.keys(pack.ontology.metrics).join(", ")})`);
  if (def.type === "product") throw new Error(`${opts.kpi} is a product of other KPIs; reconcile its parts (${def.drivers.join(", ")})`);
  const index = new ToolIndex(pack.meta!);
  const level = pack.ontology.time.levels[0];
  const all = await allPeriods(opts.tools, index, opts.kpi, level);
  const resolved = all.includes(opts.period) ? opts.period : resolvePeriods(opts.period, all, level)[0];
  if (!resolved) throw new Error(`period "${opts.period}" not found; available: ${all[0]} .. ${all[all.length - 1]}`);

  const counts = (await opts.tools.call(index.extent(opts.kpi), {}, "reconcile"))[0];
  const series = toBuckets(await opts.tools.call(index.series(opts.kpi, level), { start: String(counts.min_ts), end: String(counts.max_ts) }, "reconcile"));
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
    updateState(opts.workspace, (s) => {
      s.kpis[opts.kpi] = { status: "reconciled", reconciled: { period: resolved, expected, got, tolerance } };
    });
  }
  return result;
}

async function allPeriods(tools: ToolCaller, index: ToolIndex, metric: string, level: string): Promise<string[]> {
  const counts = (await tools.call(index.extent(metric), {}, "reconcile"))[0];
  return toBuckets(await tools.call(index.series(metric, level), { start: String(counts.min_ts), end: String(counts.max_ts) }, "reconcile")).map((b) => b.bucket);
}

export interface IncidentInput {
  workspace: string;
  kpi: string;
  /** The period label (or words like "week 10"; the agent resolves it with route first). */
  period: string;
  /** Where the user knows it was: the concept and value, and where inside what (a value of a concept, optionally inside a value of another). */
  finding: { dimension: string; value: string; scope?: Record<string, string> };
  /** The question as the user would ask it. */
  question: string;
  /** Words the cause records or the answer should contain (for example "hub outage"). */
  mention?: string[];
}

/**
 * Remember a past incident the user knows the answer to as an eval case against their real data. It is run by the
 * same runner and scored by the same scorer as every other case.
 */
export function addIncident(opts: IncidentInput): { id: string; file: string } {
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
  const id = `incident_${state.incidents.length + 1}_${opts.kpi}`;
  const playbook = loadAgents(opts.workspace).find((a) => a.kpi === opts.kpi && a.task === "deep_rca")?.playbook ?? "metric_change";
  const c = {
    id,
    question: opts.question,
    inputs: { metric: opts.kpi, period: opts.period, playbook },
    expect: { top_finding: opts.finding, ...(opts.mention?.length ? { must_mention: opts.mention } : {}) },
  };
  const cases = EvalCases.parse([...existing, c]);
  writeFileSync(file, stringify(cases, { lineWidth: 0 }), "utf-8");
  updateState(opts.workspace, (s) => {
    s.incidents.push({ id, kpi: opts.kpi, text: opts.question });
  });
  return { id, file };
}

export interface Verification {
  kpi: string;
  verified: boolean;
  reasons: string[];
  cases: { id: string; pass: boolean; detail: string }[];
}

/**
 * The only way an expert becomes `verified`: its KPI matches a number the user knows, it has at least one
 * recorded incident, and every incident case passes through the runner.
 */
export async function verifyExpert(opts: { workspace: string; kpi: string; toolbox?: string; corePlaybooksDir?: string }): Promise<Verification> {
  const state = readState(opts.workspace);
  const reasons: string[] = [];
  if (!state) throw new Error("this workspace has not been set up yet");
  if (state.kpis[opts.kpi]?.status !== "reconciled") reasons.push(`${opts.kpi} has not been matched to a number you know yet (reconcile it first)`);
  const mine = state.incidents.filter((i) => i.kpi === opts.kpi);
  if (mine.length === 0) reasons.push(`no past incident is recorded for ${opts.kpi}; record one you know the cause of`);
  if (reasons.length > 0) return { kpi: opts.kpi, verified: false, reasons, cases: [] };

  const outcomes = await runEvals({ packDir: opts.workspace, only: mine.map((i) => i.id), workRoot: join(opts.workspace, "runs", "verify"), reuse: false, toolbox: opts.toolbox, corePlaybooksDir: opts.corePlaybooksDir });
  const cases = outcomes.map((o) => ({ id: o.id, pass: "pass" in o.runner && o.runner.pass, detail: "checks" in o.runner ? o.runner.checks.filter((c) => !c.ok).map((c) => c.detail ?? c.name).join("; ") : o.runner.error }));
  const verified = cases.length > 0 && cases.every((c) => c.pass);
  if (!verified) return { kpi: opts.kpi, verified: false, reasons: cases.filter((c) => !c.pass).map((c) => `${c.id} did not find what you said happened: ${c.detail}`), cases };

  // write (or update) the KPI's deep-dive expert as verified
  const existing = loadAgents(opts.workspace).find((a) => a.kpi === opts.kpi && a.task === "deep_rca");
  const agent = AgentDef.parse({ ...(existing ?? { name: `${opts.kpi.replace(/_/g, "-")}-deep-rca`, kpi: opts.kpi, task: "deep_rca", examples: mine.map((i) => i.text) }), status: "verified" });
  mkdirSync(join(opts.workspace, "agents"), { recursive: true });
  writeFileSync(join(opts.workspace, "agents", `${agent.name}.yaml`), stringify(agent, { lineWidth: 0 }), "utf-8");
  return { kpi: opts.kpi, verified: true, reasons: [], cases };
}
