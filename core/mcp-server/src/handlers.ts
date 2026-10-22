import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { checkGenerated, generateForPack } from "@causeline/generate";
import { costCap, openData, readState, setCostCap, acceptSample, addIncident, buildStatus, cardStatus, readCard, saveCard, type CardAnswers, markSeasonalityAnalysed, confirmPlayBack, confirmNumber, connectFiles, decide, describeData, playBack, proposeChecks, recordNumber, reconcileMetric, runChecks, savePack, signoffStatus, testFact, verifyExpert } from "@causeline/builder";
import { accessMessage, bigQueryProject, type AccessProblem, budgetBytes, capGbFromDollars, connectBigQuery, defaultCapGb, sayCap, setupReadEstimate } from "@causeline/connect-bigquery";
import { effectiveExperts, routeWithData, scanKpis } from "@causeline/router";
import { analyseSeasonality, backtest, renderSeasonalityBlock, runDataChecks, type BacktestResult } from "@causeline/onboard";
import { defaultPlaybooksDir, loadPackForRun, type ToolboxInstaller, loadPlaybook, resolveThresholds, runPlaybook, ToolIndex, type RunInputs, type ToolCaller } from "@causeline/runner";
import { loadAgents, loadPack, Playbook, validatePack, type Result } from "@causeline/schema";
import type { ServerConfig } from "./config.js";

/** Hands out a ToolCaller for a run; the real one starts Toolbox, tests pass a fake. */
export interface Callers {
  caller(): Promise<ToolCaller>;
  /** Let go of what was started for the open project (the open project is changing). */
  reset?(): Promise<void>;
  /** Fetches the data connection software on first use (absent for a fake). */
  installer?: ToolboxInstaller;
}

const coreDir = (cfg: ServerConfig) => cfg.corePlaybooksDir ?? defaultPlaybooksDir();

function needPackDir(cfg: ServerConfig) {
  if (cfg.packDir === "") throw new Error("no project is open. Ask the user what to call theirs and call create_project, or call list_projects and open_project.");
  if (!existsSync(join(cfg.packDir, "ontology.yaml"))) {
    throw new Error(`the open project has no description saved yet (no ontology.yaml in ${cfg.packDir}). Set it up first with the Builder (connect_files or connect_bigquery, describe_data, save_pack), or open another project.`);
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

/** Every playbook the open project can run; a project's own hides a core one of the same name. */
export function allPlaybooks(cfg: ServerConfig) {
  const found = [...playbooksIn(join(cfg.packDir, "playbooks"), "pack"), ...playbooksIn(coreDir(cfg), "core")];
  const seen = new Set<string>();
  return found.filter((p) => !seen.has(p.playbook.name) && !!seen.add(p.playbook.name));
}

/** What an agent needs to pick a playbook and fill in its inputs. */
export function listPlaybooks(cfg: ServerConfig) {
  needPackDir(cfg);
  const { ontology: ont, data } = loadPack(cfg.packDir);
  const experts = effectiveExperts(ont, loadAgents(cfg.packDir));
  const playbooks = allPlaybooks(cfg)
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

function needProject(cfg: ServerConfig) {
  if (cfg.packDir === "") throw new Error("no project is open. Ask the user what to call theirs and call create_project, or call list_projects and open_project.");
}

/** The prep card: what the person has told us before setup, what is still to ask, and the one thing to ask next. */
export function setupCardTool(cfg: ServerConfig) {
  needProject(cfg);
  const card = readCard(cfg.packDir);
  const status = cardStatus(card);
  return {
    items: status.items,
    next: status.next || "The prep card is complete.",
    ...(card?.numbers.length ? { trusted_numbers: card.numbers, note: "These are the user's own figures and are not confirmed checks: offer one back ('you said X for week N from the Y report; shall I use that?') before using it at sign-off." } : {}),
    ...(card?.incidents.length ? { incidents: card.incidents } : {}),
  };
}

/** Record a few answers on the prep card. */
export function saveSetupCardTool(cfg: ServerConfig, args: CardAnswers) {
  needProject(cfg);
  const card = saveCard(cfg.packDir, args ?? {});
  const status = cardStatus(card);
  return { saved: true, items: status.items, next: status.next || "The prep card is complete." };
}

export async function connectFilesTool(cfg: ServerConfig, args: { files: string[] }) {
  if (!Array.isArray(args?.files) || args.files.length === 0) throw new Error("connect_files needs the paths of the user's CSV files");
  return connectFiles({ workspace: cfg.packDir, files: args.files });
}

export async function connectBigQueryTool(cfg: ServerConfig, args: { table?: string; dataset?: string; project?: string; location?: string }) {
  const result = await connectBigQuery({ workspace: cfg.packDir, ...args });
  return { ...result, next: result.connected ? "Call describe_data to look at the tables (it reads a little, and says how much), then describe the business as for files." : "Fix that and connect again." };
}

/**
 * Looking at the data. On BigQuery, when it could read more than 1 GB, the person is told first (from the tables' free metadata) and
 * nothing is read until they say go ahead.
 */
export async function describeDataTool(cfg: ServerConfig, args?: { go_ahead?: boolean }) {
  needProject(cfg);
  if (readState(cfg.packDir)?.dialect === "bigquery" && !args?.go_ahead) {
    const data = await openData(cfg.packDir);
    try {
      const est = setupReadEstimate((await data.tables()).map((t) => t.bytes), budgetBytes());
      if (est.needs_go_ahead) return { needs_go_ahead: true, say: est.say, next: "Tell the user this in plain words. If they agree, call describe_data again with go_ahead set to true; if not, narrow what is connected (one table instead of a dataset)." };
    } finally {
      await data.close();
    }
  }
  return describeData(cfg.packDir);
}

/** What one question may read, set in money or GB and read back in both; with nothing given, what is in force. */
export function costCapTool(cfg: ServerConfig, args?: { dollars?: number; gb?: number; no_limit?: boolean }) {
  needProject(cfg);
  const set = [args?.dollars, args?.gb, args?.no_limit ? 0 : undefined].filter((x) => x !== undefined);
  if (set.length > 1) throw new Error("give one of dollars, gb or no_limit");
  if (set.length === 1) {
    const gb = args!.no_limit ? 0 : args!.gb !== undefined ? args!.gb : capGbFromDollars(args!.dollars!);
    const r = setCostCap(cfg.packDir, gb);
    return { saved: true, say: sayCap(gb), ...(r.saved_in_pack ? {} : { note: "It is kept and applied when the business description is saved." }) };
  }
  const chosen = costCap(cfg.packDir);
  return { say: sayCap(chosen ?? defaultCapGb(), chosen === undefined ? "default" : "chosen") };
}

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

// --- sign-off: numbers from the user's own reports, and where each KPI stands -----------------------------------------

export async function proposeChecksTool(cfg: ServerConfig, callers: Callers, args: { kpi: string; odd_period?: { start: string; end: string; name?: string; scope?: Record<string, string> } }) {
  return proposeChecks({ workspace: cfg.packDir, kpi: args.kpi, tools: await callers.caller(), odd: args.odd_period });
}

/** Give a number: when it matches it is confirmed; with `flag` it is recorded and flagged instead. The tools' number comes back with the answer. */
export async function confirmNumberTool(cfg: ServerConfig, callers: Callers, args: { kpi: string; check: string; expected: number; source: string; tolerance?: number; flag?: boolean; note?: string }) {
  const tools = await callers.caller();
  const base = { workspace: cfg.packDir, kpi: args.kpi, check: args.check, expected: Number(args.expected), source: args.source, tolerance: args.tolerance, tools };
  if (!args.flag) return confirmNumber(base);
  const reveal = await recordNumber(base);
  const d = await decide({ workspace: cfg.packDir, kpi: args.kpi, check: args.check, decision: "flag", note: args.note, tools });
  return { ...reveal, confirmed: false, state: d.state, level: d.level, gap: d.gap };
}

/** The person has no exact figure but says the number looks right: it is kept as a plausible sample and the KPI is marked "numbers not confirmed". */
export const acceptSampleTool = (cfg: ServerConfig, args: { kpi: string; check: string; note?: string }) => acceptSample({ workspace: cfg.packDir, ...args });

export const signoffStatusTool = (cfg: ServerConfig, args: { kpi?: string } = {}) => ({ kpis: signoffStatus(cfg.packDir, args?.kpi) });

export async function runChecksTool(cfg: ServerConfig, callers: Callers, args: { kpi: string }) {
  return runChecks({ workspace: cfg.packDir, kpi: args.kpi, tools: await callers.caller() });
}

/** The message to send to whoever looks after the data, with the exact roles, for the open project (or the project and dataset given). */
export function accessHelpTool(cfg: ServerConfig, args?: { project?: string; dataset?: string; account?: string; problem?: AccessProblem }) {
  needProject(cfg);
  const bq = readState(cfg.packDir)?.bigquery;
  const project = args?.project?.trim() || bq?.project || bigQueryProject(cfg.packDir) || "";
  if (!project) throw new Error("ask the user for the Google Cloud project their queries are billed to (their own), then call this again with it");
  const cap = costCap(cfg.packDir);
  const m = accessMessage({ project, dataset: args?.dataset ?? bq?.dataset, account: args?.account, problem: args?.problem, ...(cap !== undefined && cap > 0 ? { cap_gb: cap } : {}) });
  return { ...m, next: "Show the user the message and offer to adjust it. They send it themselves; you cannot. Afterwards, call check_connection to see if it worked." };
}
