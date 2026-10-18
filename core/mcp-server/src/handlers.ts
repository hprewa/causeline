import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { checkGenerated, generateForPack } from "@causeline/generate";
import { addIncident, buildStatus, markSeasonalityAnalysed, confirmPlayBack, connectFiles, describeData, playBack, reconcileMetric, savePack, testFact, verifyExpert } from "@causeline/builder";
import { effectiveExperts, routeWithData, scanKpis } from "@causeline/router";
import { analyseSeasonality, backtest, renderSeasonalityBlock, runDataChecks, type BacktestResult } from "@causeline/onboard";
import { defaultPlaybooksDir, loadPackForRun, loadPlaybook, resolveThresholds, runPlaybook, ToolIndex, type RunInputs, type ToolCaller } from "@causeline/runner";
import { loadAgents, loadPack, Playbook, validatePack, type Result } from "@causeline/schema";
import type { ServerConfig } from "./config.js";

/** Hands out a ToolCaller for a run; the real one starts Toolbox, tests pass a fake. */
export interface Callers {
  caller(): Promise<ToolCaller>;
}

const coreDir = (cfg: ServerConfig) => cfg.corePlaybooksDir ?? defaultPlaybooksDir();

function needPackDir(cfg: ServerConfig) {
  if (!existsSync(join(cfg.packDir, "ontology.yaml"))) {
    throw new Error(`no ontology.yaml in ${cfg.packDir}. Point CAUSELINE_PACK at a pack directory (one holding ontology.yaml, data.yaml and toolbox/).`);
  }
}

/** The pack's definition files and generated tool index; says plainly what is missing. */
function packOrThrow(cfg: ServerConfig) {
  needPackDir(cfg);
  return loadPackForRun(cfg.packDir);
}

function playbooksIn(dir: string, source: "pack" | "core") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => ({ source, playbook: Playbook.parse(parse(readFileSync(join(dir, f), "utf-8"))) }));
}

/** What an agent needs to pick a playbook and fill in its inputs. */
export function listPlaybooks(cfg: ServerConfig) {
  needPackDir(cfg);
  const { ontology: ont, data } = loadPack(cfg.packDir);
  const experts = effectiveExperts(ont, loadAgents(cfg.packDir));
  const found = [...playbooksIn(join(cfg.packDir, "playbooks"), "pack"), ...playbooksIn(coreDir(cfg), "core")];
  const seen = new Set<string>();
  const playbooks = found
    .filter((p) => !seen.has(p.playbook.name) && !!seen.add(p.playbook.name)) // a pack's playbook hides a core one of the same name
    .map((p) => ({ name: p.playbook.name, description: p.playbook.description, source: p.source, inputs: p.playbook.inputs }));
  return {
    pack: cfg.packDir,
    playbooks,
    ontology: {
      period_level: ont.time.levels[0],
      time_levels: ont.time.levels,
      hierarchies: ont.hierarchies,
      dimensions: ont.dimensions,
      metrics: Object.entries(ont.metrics).map(([name, m]) => ({ name, type: m.type, direction: m.direction ?? null, ...(m.description ? { description: m.description } : {}), supported: true })),
      experts: experts.map((e) => ({ name: e.name, kpi: e.kpi, task: e.task, playbook: e.playbook ?? null, status: e.status })),
      evidence: Object.entries(data.evidence).map(([name, e]) => ({ name, about: e.about, ...(e.description ? { description: e.description } : {}) })),
    },
    notes: [
      `period is a bucket label at the top time level (${ont.time.levels[0]}); if it is not found, run_playbook says which labels exist`,
      "route(question) says which KPI, task and expert fit a plain question; call it first and say what it chose",
      "run_playbook is the way to get numbers: report only what its result contains",
    ],
  };
}

export interface RunArgs {
  name: string;
  inputs?: Record<string, string | number | boolean>;
}

/** Run a playbook, keep its result.json on disk, and return it. */
export async function runPlaybookTool(cfg: ServerConfig, callers: Callers, args: RunArgs): Promise<{ file: string; result: Result }> {
  const { ontology, meta } = packOrThrow(cfg);
  const inputs: RunInputs = args.inputs ?? {};
  for (const [k, v] of Object.entries(inputs)) {
    if (!["string", "number", "boolean"].includes(typeof v)) throw new Error(`input "${k}" must be a string, number or boolean`);
  }
  const playbook = loadPlaybook(args.name, cfg.packDir, coreDir(cfg));
  const result = await runPlaybook({ playbook, ontology, meta, tools: await callers.caller(), inputs });

  mkdirSync(cfg.runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = [args.name, inputs.metric, inputs.period].filter(Boolean).join("-").replace(/[^\w.-]+/g, "_");
  const file = join(cfg.runsDir, `${stamp}-${label}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n", "utf-8");
  return { file, result };
}

/** Checks on the pack's files and how they fit together. Checks against the data itself are the check_data tool. */
export function validatePackTool(cfg: ServerConfig) {
  if (!existsSync(join(cfg.packDir, "ontology.yaml"))) throw new Error(`no ontology.yaml in ${cfg.packDir}`);
  let pack;
  try {
    pack = loadPack(cfg.packDir);
  } catch (e) {
    return { valid: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [] as string[], generated_tools: "unknown" as const, data_checks: "run check_data" as const };
  }
  const playbooks = [...playbooksIn(join(cfg.packDir, "playbooks"), "pack"), ...playbooksIn(coreDir(cfg), "core")].map((p) => p.playbook);
  const { errors, warnings } = validatePack({ ontology: pack.ontology, data: pack.data, meta: pack.meta, playbooks });
  const generated = checkGenerated(cfg.packDir);
  if (generated !== "fresh") warnings.push(`generated tools are ${generated}: run generate_tools`);
  return { valid: errors.length === 0, errors, warnings, generated_tools: generated, data_checks: "run check_data" as const };
}

/** Which KPI, task and expert fit a question, and the one thing still missing, if any. Deterministic. */
export async function routeTool(cfg: ServerConfig, callers: Callers, args: { question: string }) {
  if (!args?.question || typeof args.question !== "string") throw new Error("route needs a question (a string)");
  packOrThrow(cfg);
  return routeWithData({ packDir: cfg.packDir, question: args.question, tools: await callers.caller(), corePlaybooksDir: cfg.corePlaybooksDir });
}

/** Check every KPI for a period and say which moved: the first step of a vague question. */
export async function scanKpisTool(cfg: ServerConfig, callers: Callers, args: { period: string }) {
  if (!args?.period || typeof args.period !== "string") throw new Error("scan_kpis needs a period label (for example the one route returned)");
  packOrThrow(cfg);
  return scanKpis({ packDir: cfg.packDir, period: args.period, tools: await callers.caller(), corePlaybooksDir: cfg.corePlaybooksDir });
}

/** ontology.yaml -> toolbox/tools.generated.yaml. Toolbox hot-reloads the folder, so nothing else is needed. */
export function generateToolsTool(cfg: ServerConfig) {
  loadPack(cfg.packDir);
  const { path, metaPath, generated } = generateForPack(cfg.packDir);
  return {
    path,
    meta_path: metaPath,
    tools: generated.tools.length,
    skipped_metrics: generated.skipped,
    note: "Toolbox reloads its config folder automatically; no restart is needed.",
  };
}

async function extentOf(tools: ToolCaller, index: ToolIndex, metric: string) {
  const counts = (await tools.call(index.extent(metric), {}, "onboarding"))[0];
  return { start: String(counts.min_ts), end: String(counts.max_ts) };
}

export interface SeasonalityArgs {
  metrics?: string[];
  /** Also replay recent periods with and without the recommendation (slow: starts a second Toolbox). */
  backtest?: boolean;
}

/**
 * Is any metric seasonal, in which cycles, and what should `time.seasonality` say? Deterministic: the
 * agent explains and the user confirms; it does not decide. Cycles with too little history are reported
 * as cannot_assess, never as "not seasonal".
 */
export async function analyzeSeasonalityTool(cfg: ServerConfig, callers: Callers, args: SeasonalityArgs = {}) {
  const { ontology, data, meta } = packOrThrow(cfg);
  const index = new ToolIndex(meta);
  const tools = await callers.caller();
  const first = Object.keys(data.metrics).find((m) => !args.metrics || args.metrics.includes(m)) ?? Object.keys(data.metrics)[0];
  const analysis = await analyseSeasonality({ ontology, data, tools, index, th: resolveThresholds(ontology.thresholds), extent: await extentOf(tools, index, first), metrics: args.metrics });
  let replay: BacktestResult | undefined;
  if (args.backtest) replay = await backtest({ packDir: cfg.packDir, ontology, data, recommended: analysis.recommended, metrics: args.metrics, binary: cfg.toolboxBinary });
  const declared = ontology.time.seasonality === "none" ? "none" : "declared";
  markSeasonalityAnalysed(cfg.packDir);
  return {
    current_ontology: declared,
    recommended_block: renderSeasonalityBlock(analysis.recommended),
    ...analysis,
    ...(replay ? { backtest: replay } : {}),
    next: "Explain the findings to the user and confirm every field. To apply: put the block under `time:` in ontology.yaml, run generate_tools, then validate_pack and check_data.",
  };
}

/** Structural checks against the data itself: parents, gaps, nulls, ranges, history and node thickness. */
export async function checkDataTool(cfg: ServerConfig, callers: Callers) {
  const { ontology, data, meta } = packOrThrow(cfg);
  const checks = await runDataChecks({ ontology, data, tools: await callers.caller(), index: new ToolIndex(meta) });
  const count = (s: string) => checks.filter((c) => c.status === s).length;
  return { passed: count("pass"), warnings: count("warn"), failures: count("fail"), ok: count("fail") === 0, checks };
}

// --- the Builder: from the user's own files to a pack, by conversation ------------------------------------------------
// The workspace is the pack directory (CAUSELINE_PACK). These tools write the files, run and check what the agent
// drafts, and refuse to call anything done that has not been checked.

export const buildStatusTool = (cfg: ServerConfig) => buildStatus(cfg.packDir);

export async function connectFilesTool(cfg: ServerConfig, args: { files: string[] }) {
  if (!Array.isArray(args?.files) || args.files.length === 0) throw new Error("connect_files needs the paths of the user's CSV files");
  return connectFiles({ workspace: cfg.packDir, files: args.files });
}

export const describeDataTool = (cfg: ServerConfig) => describeData(cfg.packDir);

export async function testFactTool(cfg: ServerConfig, args: { sql: string; time?: string; concepts?: string[] }) {
  return testFact({ workspace: cfg.packDir, sql: args.sql, time: args.time, concepts: args.concepts });
}

export async function savePackTool(cfg: ServerConfig, args: { ontology: unknown; data: unknown; agents?: unknown[] }) {
  const result = await savePack({ workspace: cfg.packDir, ontology: args.ontology, data: args.data, agents: args.agents });
  return { ...result, next: result.saved ? "Call play_back and read the sentences to the user for confirmation, then reconcile each KPI." : "Fix the errors and save again; nothing was written." };
}

export const playBackTool = (cfg: ServerConfig, args: { confirm?: boolean } = {}) => (args?.confirm ? confirmPlayBack(cfg.packDir) : playBack(cfg.packDir));

export async function reconcileMetricTool(cfg: ServerConfig, callers: Callers, args: { kpi: string; period: string; expected: number; tolerance?: number }) {
  return reconcileMetric({ workspace: cfg.packDir, kpi: args.kpi, period: args.period, expected: Number(args.expected), tolerance: args.tolerance, tools: await callers.caller() });
}

export const addIncidentTool = (cfg: ServerConfig, args: Parameters<typeof addIncident>[0] extends infer T ? Omit<T & object, "workspace"> : never) => addIncident({ workspace: cfg.packDir, ...(args as object) } as Parameters<typeof addIncident>[0]);

export const verifyExpertTool = (cfg: ServerConfig, args: { kpi: string }) => verifyExpert({ workspace: cfg.packDir, kpi: args.kpi, toolbox: cfg.toolboxBinary, corePlaybooksDir: cfg.corePlaybooksDir });
