import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { checkGenerated, generateForPack } from "@causeline/generate";
import { calibrate, calibrationStatus, labelPeriod, sayRate, type CalibrationReport, discoverForKpi, costCap, openData, readState, setCostCap, acceptSample, addIncident, buildStatus, cardStatus, readCard, saveCard, type CardAnswers, markSeasonalityAnalysed, confirmPlayBack, confirmNumber, connectFiles, decide, describeData, playBack, proposeChecks, recordNumber, reconcileMetric, runChecks, savePack, signoffStatus, testFact, verifyExpert } from "@causeline/builder";
import { sayBytes, sayUsd, accessMessage, beginSignIn, bigQueryProject, hasClientFile, hasOwnSignIn, saveClientFile, signInInUse, useOwnSignIn, type AccessProblem, budgetBytes, capGbFromDollars, connectBigQuery, defaultCapGb, sayCap, setupReadEstimate } from "@causeline/connect-bigquery";
import { effectiveExperts, routeWithData, scanKpis } from "@causeline/router";
import { analyseSeasonality, backtest, renderSeasonalityBlock, runDataChecks, type BacktestResult } from "@causeline/onboard";
import { causelineHome, defaultPlaybooksDir, loadPackForRun, type ToolboxInstaller, loadPlaybook, resolveThresholds, runPlaybook, ToolIndex, type RunInputs, type ToolCaller } from "@causeline/runner";
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

/** The cost limit in force, said in words, with an instruction to offer the person a different one until they have chosen. */
export function limitNote(cfg: ServerConfig) {
  const chosen = costCap(cfg.packDir);
  const say = sayCap(chosen ?? defaultCapGb(), chosen === undefined ? "default" : "chosen");
  return chosen === undefined
    ? { say, ask_user: "Tell the user this limit in plain words and ask once whether they want a different one (for example 'about $1'); set it with cost_limit. They have not chosen one yet." }
    : { say };
}

export async function connectBigQueryTool(cfg: ServerConfig, args: { table?: string; dataset?: string; project?: string; location?: string }) {
  const result = await connectBigQuery({ workspace: cfg.packDir, ...args });
  // a connection that worked is the evidence of read access; what the person says about it is not
  if (result.connected && readCard(cfg.packDir)) saveCard(cfg.packDir, { access: { confirmed: true } });
  return {
    ...result,
    ...(result.connected ? { cost_limit: limitNote(cfg) } : {}),
    next: result.connected ? "Say the cost limit to the user and ask once if they want a different one (cost_limit). With several tables, use discover_for_kpi to pick the ones the KPI needs; with one, call describe_data (it reads a little, and says how much). Then describe the business as for files." : "Fix that and connect again.",
  };
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
      if (est.needs_go_ahead) return { needs_go_ahead: true, say: est.say, cost_limit: limitNote(cfg), next: "Tell the user this in plain words. If they agree, call describe_data again with go_ahead set to true; if not, narrow what is connected (one table instead of a dataset)." };
    } finally {
      await data.close();
    }
  }
  const description = await describeData(cfg.packDir);
  return readState(cfg.packDir)?.dialect === "bigquery" ? { ...description, cost_limit: limitNote(cfg) } : description;
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
  const proposed = await proposeChecks({ workspace: cfg.packDir, kpi: args.kpi, tools: await callers.caller(), odd: args.odd_period });
  return { ...proposed, ...cardReminder(cfg) };
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
/** What is still open on the prep card, as a reminder to tack onto results that come late in a conversation; nothing when it is complete or there is none. */
export function cardReminder(cfg: ServerConfig): { still_to_ask: string } | Record<string, never> {
  const card = readCard(cfg.packDir);
  if (!card) return {};
  const next = cardStatus(card).next;
  return next ? { still_to_ask: `The prep card is not finished. Before you move on, ${next[0].toLowerCase()}${next.slice(1)}` } : {};
}

export function acceptSampleTool(cfg: ServerConfig, args: { kpi: string; check: string; note?: string }) {
  const r = acceptSample({ workspace: cfg.packDir, ...args });
  return {
    ...r,
    say: `The figure for that check is ${r.got.toLocaleString("en-US")}. It covers the whole period of the check, not one day. Quote it as it is; do not divide it, average it or call a day typical, and say the newest day may be partial.`,
    ...cardReminder(cfg),
  };
}

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

// --- calibration: does the analysis cry wolf? ---------------------------------------------------------------------------

/** A calibration report in the words the person is told: every figure comes from the replay, and the next thing to do is said. */
export function describeCalibration(r: CalibrationReport) {
  const ev = r.evaluation;
  if (r.stage === "not_ready") return { ...r, say: r.reasons.join(" "), next: "Get the KPI reconciled first (the numbers from the user's own reports), then calibrate." };
  if (r.stage === "needs_go_ahead") {
    const e = r.estimate!;
    return {
      ...r,
      needs_go_ahead: true,
      say: `Checking ${e.periods} past periods would read ${e.measured ? "about" : "roughly"} ${sayBytes(e.total_bytes)} in all (${sayUsd(e.total_bytes)}), about ${sayBytes(e.bytes_per_period)} each. Each period keeps to your limit for one question.`,
      next: "Tell the user this in plain words and ask whether to go ahead. If they agree, call calibrate again with go_ahead set to true; if not, nothing is read.",
    };
  }
  const looked = `I have looked at ${r.progress.done} of ${r.progress.total} past periods.`;
  if (r.stage === "running") {
    return { ...r, say: `${looked} So far ${ev!.alarms} of the ${ev!.judged} I could judge raised something.`, next: "Say the progress in a few words and call calibrate again to continue; it picks up where it stopped." };
  }
  const base = `Of the ${ev!.judged} ordinary periods I could judge, ${ev!.alarms} raised something (${sayRate(ev!.rate)}). You allow ${sayRate(ev!.allowed)}.`;
  const skipped = ev!.not_judged > 0 ? ` ${ev!.not_judged} period${ev!.not_judged === 1 ? " was" : "s were"} not judged (the analysis said it could not compare ${ev!.not_judged === 1 ? "it" : "them"} fairly) and ${ev!.not_judged === 1 ? "is" : "are"} not counted.` : "";
  const real = ev!.real_events > 0 ? ` ${ev!.real_events} ${ev!.real_events === 1 ? "was" : "were"} left out because you said something real happened then.` : "";
  if (!ev!.enough) {
    return { ...r, say: `${base}${skipped}${real} That is too few quiet periods to say anything: at least 8 are needed, so the KPI stays ${r.level}.`, next: "Say that more history is needed. Nothing else can be done now." };
  }
  if (ev!.pass) {
    return { ...r, say: `${base}${skipped}${real} It stays quiet enough, so the KPI is now ${r.level}. With only ${ev!.judged} periods the true rate could still be as high as ${sayRate(ev!.upper)}.`, next: "Say the result, then carry on (past incidents, then verify_expert)." };
  }
  return {
    ...r,
    say: `${base}${skipped}${real} That is more than you allow, so the KPI stays ${r.level}.`,
    next: r.flagged.length > 0
      ? "Ask the user about the flagged periods ONE AT A TIME: 'Was something real going on around <words>?' using what it said (flagged[].what). Record each answer with label_period (real true or false), then call calibrate again. A yes is a real event: it stops counting against the KPI, and is worth recording as a past incident. Do not argue the numbers away."
      : "Every flagged period has been answered. Say plainly that it raises something more often than allowed; the allowed rate can be changed only if the user chooses (calibrate with allowed_false_alarm_rate).",
  };
}

export async function calibrateTool(cfg: ServerConfig, callers: Callers, args: { kpi: string; allowed_false_alarm_rate?: number; go_ahead?: boolean }) {
  needProject(cfg);
  if (!args?.kpi) throw new Error("say which KPI to calibrate");
  const r = await calibrate({ workspace: cfg.packDir, kpi: args.kpi, makeTools: () => callers.caller(), corePlaybooksDir: cfg.corePlaybooksDir, allowed: args.allowed_false_alarm_rate, goAhead: args.go_ahead });
  return describeCalibration(r);
}

export function labelPeriodTool(cfg: ServerConfig, args: { kpi: string; period: string; real: boolean; note?: string }) {
  needProject(cfg);
  if (typeof args?.real !== "boolean") throw new Error("say whether something real happened (real true or false)");
  const r = labelPeriod(cfg.packDir, args.kpi, args.period, args.real, args.note);
  const open = r.evaluation.flagged.length;
  return {
    period: r.period,
    real: r.real,
    evaluation: r.evaluation,
    say: r.real ? "Noted: that period had something real in it, so it no longer counts against the KPI." : "Noted: nothing real happened then, so it still counts as a false alarm.",
    next: open > 0 ? `${open} flagged period${open === 1 ? " is" : "s are"} still unanswered: ask about the next one.` : "Every flagged period is answered: call calibrate again to record the result.",
  };
}

export function calibrationStatusTool(cfg: ServerConfig, args: { kpi: string }) {
  needProject(cfg);
  const s = calibrationStatus(cfg.packDir, args.kpi);
  if (!s.replayed) return { ...s, say: `${args.kpi} has not been checked for false alarms yet.`, next: "Call calibrate when the KPI is reconciled." };
  const ev = s.evaluation!;
  return { ...s, say: `${ev.alarms} of ${ev.judged} ordinary periods raised something (${sayRate(ev.rate)}); allowed ${sayRate(ev.allowed)}.` };
}

// --- signing in to Google without a terminal ---------------------------------------------------------------------------

let signInAttempt: { status: "waiting" | "done" | "failed"; say?: string } | undefined;

/**
 * Start a sign-in: opens Google's page in the browser. The person finishes there and tells the assistant, which then checks the connection.
 * The first time, the administrator's sign-in file is needed (a path to it, given once).
 */
export async function signInTool(cfg: ServerConfig, callers: Callers, args?: { client_file?: string }) {
  const home = cfg.home ?? causelineHome();
  if (args?.client_file?.trim()) saveClientFile(home, args.client_file.trim());
  if (!hasClientFile(home)) {
    return {
      needs_client: true,
      say: "To sign in without a terminal, I need a small sign-in file from whoever looks after your Google Cloud account. It is made once for everyone who signs in and it holds no password.",
      next: "Tell the user to ask their administrator for a Google sign-in file for a desktop app (the guide for administrators has the steps), and to give you the file when they have it. Then call sign_in again with its path as client_file. If they can use a terminal, signing in with Google's own tool also works.",
    };
  }
  const { url, done } = await beginSignIn({ home });
  signInAttempt = { status: "waiting" };
  void done.then(async (r) => {
    if (r.ok) {
      useOwnSignIn(home);
      await callers.reset?.(); // the data connection software starts again and picks the new sign-in up
      signInAttempt = { status: "done" };
    } else signInAttempt = { status: "failed", say: r.say };
  });
  return {
    started: true,
    say: "A Google sign-in page has opened in your browser. Choose your account and allow access, then come back here and tell me when you are done.",
    link: url,
    next: "Tell the user a page opened, and give them the link in case it did not. When they say they are done, call check_connection. You never see their password or anything they type on Google's page.",
  };
}

/** Add which sign-in is in use, and what the last attempt did, to a connection check; point at signing in when that is the fix. */
export function withSignIn<T extends { ok: boolean; problem?: AccessProblem; advice?: string }>(cfg: ServerConfig, check: T): T & { sign_in: Record<string, unknown> } {
  const home = cfg.home ?? causelineHome();
  const using = signInInUse(home);
  const sign_in: Record<string, unknown> = {
    using: using === "causeline" ? "Causeline's own Google sign-in" : using === "other_settings" ? "the Google sign-in set in this computer's settings" : "Google's own tool on this computer (or none)",
    file_ready: hasClientFile(home),
    signed_in_with_causeline: hasOwnSignIn(home),
    ...(signInAttempt ? { last_attempt: signInAttempt.status === "failed" ? signInAttempt.say : signInAttempt.status } : {}),
  };
  const fixable = check.problem === "not_signed_in" || check.problem === "expired";
  const advice = fixable && hasClientFile(home) ? "Sign in with Google again: I can open the page for you (sign_in)." : fixable ? `${check.advice ?? ""} If you cannot use a terminal, your administrator can make a Google sign-in file once for everyone; then I can open the sign-in page for you.`.trim() : check.advice;
  return { ...check, ...(advice ? { advice } : {}), sign_in };
}

/**
 * Discovery that starts from one KPI. First call (no tables): reads nothing, lists the connected tables that fit the KPI. Second call (the
 * tables the user confirmed): looks at only those, after telling the cost if it could pass 1 GB, and returns the draft in sentences and the risks.
 */
export async function discoverForKpiTool(cfg: ServerConfig, args: { kpi?: string; tables?: string[]; go_ahead?: boolean }) {
  needProject(cfg);
  const card = readCard(cfg.packDir);
  const kpi = (args?.kpi ?? card?.kpi ?? "").trim();
  if (!kpi) throw new Error("ask the user which KPI to start from, in their words, then call this with it");
  if (args?.tables?.length && !args.go_ahead) {
    const data = await openData(cfg.packDir);
    try {
      const all = await data.tables();
      const chosen = args.tables.map((n) => all.find((t) => t.name === n || t.name.split(".").pop() === n)).filter((t): t is NonNullable<typeof t> => !!t);
      const est = setupReadEstimate(chosen.map((t) => t.bytes), budgetBytes());
      if (est.needs_go_ahead) return { needs_go_ahead: true, say: est.say, next: "Tell the user this in plain words. If they agree, call again with go_ahead set to true; if not, choose fewer or smaller tables." };
    } finally {
      await data.close();
    }
  }
  return discoverForKpi({ workspace: cfg.packDir, kpi, hint: card?.how_calculated, tables: args?.tables });
}
