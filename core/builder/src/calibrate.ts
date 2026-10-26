import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { completeBuckets } from "@causeline/router";
import { RunStop, ToolIndex, loadPlaybook, runPlaybook, type Bucket, type ToolCaller } from "@causeline/runner";
import { atLeast, EvalCases, loadPack, type Result } from "@causeline/schema";
import { dayWords, syncExperts } from "./checks.js";
import { levelGap, levelOf, logChange, readState, updateState, type Level } from "./state.js";

/**
 * Calibration: does the analysis cry wolf? The KPI's deep dive is replayed over its own past periods; every period in which it claims
 * something (a significant headline, a finding, or a hidden-slot flag) counts as a false alarm unless the person says something real happened
 * then. A period the analysis declines to judge (a holiday week with no comparable baseline, data still arriving) is reported and is in
 * neither count. The rate is compared with what the person allows (one in twenty unless they change it).
 *
 * Every period's outcome is kept in the project (`calibration-<kpi>.json`) as soon as it is known, so a stopped run resumes, a label never
 * needs a re-run, and a changed KPI (a different formula) starts again.
 */

/** Bump when the meaning of "alarm" changes: kept outcomes from an older meaning are not reused. */
export const ALARM_RULE_VERSION = 1;
export const DEFAULT_ALLOWED = 0.05;
/** Fewest judged ordinary periods that can earn the rung (with fewer, the rate says almost nothing). */
export const MIN_JUDGED = 8;
export const DEFAULT_PERIODS = 26;
/** How long one call works before it reports progress and asks to be called again (clients time a tool call out after about a minute). */
export const CHUNK_MS = 40_000;
/** Above this many bytes the person's go-ahead is needed before a cloud replay (the same threshold as looking at data). */
export const GO_AHEAD_BYTES = 1e9;
/** A deep dive reads about this many full scans of the tables: a rough figure for the estimate shown before the first period is measured. */
const SCANS_PER_PERIOD = 6;

export interface PeriodOutcome {
  period: string;
  start: string;
  end: string;
  /** judged: the analysis gave an answer. not_judged: it declined, or could not run, and nothing is counted. */
  status: "judged" | "not_judged";
  alarm: boolean;
  /** What it claimed, in words (for a judged alarm). */
  why: string[];
  /** Why it was not judged. */
  reason?: string;
  bytes?: number;
  at: string;
}

interface Label {
  real: boolean;
  note?: string;
  at: string;
}

interface CalibrationFile {
  version: 1;
  kpi: string;
  key: string;
  allowed: number;
  adjustments: { at: string; from: number; to: number }[];
  /** What the first period read, for the estimate of the rest. */
  first_bytes?: number;
  outcomes: Record<string, PeriodOutcome>;
  labels: Record<string, Label>;
}

const fileOf = (workspace: string, kpi: string) => join(workspace, `calibration-${kpi}.json`);

function readFile(workspace: string, kpi: string): CalibrationFile | null {
  const f = fileOf(workspace, kpi);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, "utf-8")) as CalibrationFile;
    return raw?.version === 1 ? raw : null;
  } catch {
    return null;
  }
}

const writeFile = (workspace: string, file: CalibrationFile) => writeFileSync(fileOf(workspace, file.kpi), JSON.stringify(file, null, 2) + "\n", "utf-8");

/** What a run says, as a claim or not: only a finished run can claim something. */
export function alarmOf(r: Pick<Result, "status" | "headline" | "findings" | "masking_flags">): { alarm: boolean; why: string[] } {
  if (r.status !== "complete") return { alarm: false, why: [] };
  const why: string[] = [];
  if (r.headline?.significant) why.push(`a significant change in the headline (${(r.headline.z ?? 0) > 0 ? "up" : "down"})`);
  if (r.findings.length > 0) why.push(`${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}, the first in ${r.findings[0].dimension.replace(/_/g, " ")} ${r.findings[0].value}`);
  const hidden = r.masking_flags.filter((f) => f.type !== "small_cells");
  if (hidden.length > 0 && r.findings.length === 0) why.push(`a possible hidden pattern (${hidden[0].type})`);
  return { alarm: why.length > 0, why };
}

/** The upper end of a 95% interval for a rate of k out of n (Wilson), so a small sample says how little it shows. */
export function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 1;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  return Math.min(1, (p + (z * z) / (2 * n) + z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom);
}

export interface Evaluation {
  judged: number;
  not_judged: number;
  real_events: number;
  alarms: number;
  rate: number;
  upper: number;
  allowed: number;
  enough: boolean;
  pass: boolean;
  flagged: PeriodOutcome[];
}

/** Count the outcomes. A period the person called real is not a quiet one: it is in neither the count nor the rate. */
export function evaluate(outcomes: PeriodOutcome[], labels: Record<string, Label>, allowed: number): Evaluation {
  const real = (o: PeriodOutcome) => labels[o.period]?.real === true;
  const judged = outcomes.filter((o) => o.status === "judged" && !real(o));
  const alarms = judged.filter((o) => o.alarm);
  const rate = judged.length > 0 ? alarms.length / judged.length : 0;
  const enough = judged.length >= MIN_JUDGED;
  return {
    judged: judged.length,
    not_judged: outcomes.filter((o) => o.status === "not_judged").length,
    real_events: outcomes.filter((o) => o.status === "judged" && real(o)).length,
    alarms: alarms.length,
    rate,
    upper: wilsonUpper(alarms.length, judged.length),
    allowed,
    enough,
    pass: enough && rate <= allowed,
    // a flagged period nobody has answered about yet
    flagged: alarms.filter((o) => labels[o.period] === undefined),
  };
}

/** "about 1 in 12" for a rate; "none" for zero. */
export function sayRate(rate: number): string {
  if (rate <= 0) return "none";
  const n = Math.round(1 / rate);
  return n <= 1 ? "all" : `about 1 in ${n}`;
}

/** The windows of incidents the person recorded for a KPI (periods and date ranges), so that they are not counted as ordinary periods. */
export function incidentWindows(workspace: string, kpi: string): { period?: string; start?: string; end?: string }[] {
  const f = join(workspace, "evals", "cases.yaml");
  if (!existsSync(f)) return [];
  try {
    return EvalCases.parse(parse(readFileSync(f, "utf-8")))
      .filter((c) => c.inputs?.metric === kpi && c.id.startsWith("incident_"))
      .map((c) => ({ period: c.inputs!.period || undefined, start: (c.inputs!.more as Record<string, string> | undefined)?.start_date, end: (c.inputs!.more as Record<string, string> | undefined)?.end_date }));
  } catch {
    return [];
  }
}

const overlapsIncident = (b: Bucket, windows: ReturnType<typeof incidentWindows>) =>
  windows.some((w) => (w.period && w.period === b.bucket) || (w.start && w.end && b.bucket_start.slice(0, 10) <= w.end && b.bucket_end.slice(0, 10) >= w.start));

export interface CalibrationDeps {
  /** The complete past periods of the top time level, oldest first. */
  periods(): Promise<Bucket[]>;
  /** Run the deep dive for one period with its own tools (its own budget). */
  runOne(period: Bucket): Promise<{ result: Result | null; stopped?: string; bytes?: number }>;
  /** Changes when the KPI's meaning does. */
  key(): string;
  /** Bytes the tables hold, for the estimate (cloud data only). */
  tableBytes?(): Promise<number>;
  baseline: number;
}

export interface CalibrateOptions {
  workspace: string;
  kpi: string;
  makeTools: () => Promise<ToolCaller>;
  corePlaybooksDir?: string;
  /** A new allowed false-alarm rate (a fraction); the change is recorded. */
  allowed?: number;
  /** The person agreed to what the replay reads. */
  goAhead?: boolean;
  maxPeriods?: number;
  chunkMs?: number;
  baseline?: number;
  /** Replace the real run (the tests). */
  deps?: CalibrationDeps;
}

export type CalibrationStage = "not_ready" | "needs_go_ahead" | "running" | "done";

export interface CalibrationReport {
  kpi: string;
  stage: CalibrationStage;
  /** Why it cannot start (not_ready). */
  reasons: string[];
  /** Before a cloud replay: what it would read. */
  estimate?: { periods: number; bytes_per_period: number; total_bytes: number; measured: boolean };
  progress: { done: number; total: number };
  evaluation?: Evaluation;
  /** Periods that raised something, in words, for the person to say whether something real happened. */
  flagged: { period: string; words: string; what: string[] }[];
  /** Periods the analysis declined to judge, with why. */
  not_judged: { period: string; words: string; reason: string }[];
  level?: Level;
  gap?: string;
}

/** What a KPI means for the checks that depend on it: its definition, the fact it counts over, the time levels, the baseline and the alarm rule. */
function meaningOf(pack: ReturnType<typeof loadPack>, kpi: string, baseline: number): string {
  const factName = pack.data.metrics[kpi]?.fact;
  return JSON.stringify({ metric: pack.ontology.metrics[kpi], data: pack.data.metrics[kpi], fact: factName ? pack.data.facts[factName] : null, levels: pack.ontology.time, baseline, rule: ALARM_RULE_VERSION });
}

/** The same fingerprint `calibrate` keeps its outcomes under, so that other checks can tell whether they were made for the KPI as it is now. */
export function kpiKey(workspace: string, kpi: string, baseline = 4): string {
  return createHash("sha256").update(meaningOf(loadPack(workspace, { requireMeta: true }), kpi, baseline)).digest("hex").slice(0, 16);
}

/** The ordinary periods the false-alarm check found for a KPI, newest first: judged, raised nothing, and not called real by the person. Empty when it has not been run. */
export function quietPeriods(workspace: string, kpi: string): PeriodOutcome[] {
  const file = readFile(workspace, kpi);
  if (!file) return [];
  return Object.values(file.outcomes)
    .filter((o) => o.status === "judged" && !o.alarm && file.labels[o.period]?.real !== true)
    .sort((a, b) => b.start.localeCompare(a.start));
}

function realDeps(opts: CalibrateOptions): CalibrationDeps {
  const pack = loadPack(opts.workspace, { requireMeta: true });
  const def = pack.ontology.metrics[opts.kpi];
  if (!def) throw new Error(`"${opts.kpi}" is not a KPI in this pack (have: ${Object.keys(pack.ontology.metrics).join(", ")})`);
  if (def.type === "product") throw new Error(`${opts.kpi} is a product of other KPIs; calibrate its parts (${def.drivers.join(", ")})`);
  const index = new ToolIndex(pack.meta!);
  const level = pack.ontology.time.levels[0];
  const playbook = loadPlaybook("metric_change", opts.workspace, opts.corePlaybooksDir);
  const baseline = opts.baseline ?? 4;
  const meaning = meaningOf(pack, opts.kpi, baseline);
  return {
    baseline,
    key: () => createHash("sha256").update(meaning).digest("hex").slice(0, 16),
    periods: async () => completeBuckets(await opts.makeTools(), index, opts.kpi, level),
    runOne: async (period) => {
      try {
        const result = await runPlaybook({ playbook, ontology: pack.ontology, meta: pack.meta!, tools: await opts.makeTools(), inputs: { metric: opts.kpi, period: period.bucket, baseline } });
        return { result, bytes: result.cost?.bytes_scanned };
      } catch (e) {
        if (e instanceof RunStop) return { result: null, stopped: e.detail ?? e.message };
        return { result: null, stopped: (e as Error).message };
      }
    },
    tableBytes: async () => {
      const state = readState(opts.workspace);
      if (state?.dialect !== "bigquery") return 0;
      const { openData } = await import("./data.js");
      const data = await openData(opts.workspace);
      try {
        return (await data.tables()).reduce((a, t) => a + (t.bytes ?? 0), 0);
      } finally {
        await data.close();
      }
    },
  };
}

const wordsOf = (b: { bucket_start: string; bucket_end: string }) => dayWords(b.bucket_start.slice(0, 10), b.bucket_end.slice(0, 10));

/**
 * Replay a KPI's past periods and, when every one has an outcome, decide whether it stays quiet enough. Returns after about `chunkMs` of work
 * with the progress, so a long replay takes several steps and running it again continues. Needs a reconciled KPI: calibrating numbers nobody has
 * matched to a report would only measure noise.
 */
export async function calibrate(opts: CalibrateOptions): Promise<CalibrationReport> {
  const state = readState(opts.workspace);
  if (!state) throw new Error("this workspace has not been set up yet");
  const rec = state.kpis[opts.kpi];
  const empty = { progress: { done: 0, total: 0 }, flagged: [], not_judged: [] };
  if (!atLeast(levelOf(rec), "reconciled")) {
    return { kpi: opts.kpi, stage: "not_ready", reasons: [`${opts.kpi} is not reconciled yet (it is ${levelOf(rec)}): ${levelGap(rec)}`], ...empty };
  }
  const deps = opts.deps ?? realDeps(opts);
  let file = readFile(opts.workspace, opts.kpi);
  const key = deps.key();
  if (!file || file.key !== key) {
    // a different meaning of the KPI: earlier outcomes do not apply (what the person said was real stays on record)
    file = { version: 1, kpi: opts.kpi, key, allowed: file?.allowed ?? DEFAULT_ALLOWED, adjustments: file?.adjustments ?? [], outcomes: {}, labels: file?.labels ?? {} };
  }
  if (opts.allowed !== undefined) {
    if (!(opts.allowed > 0 && opts.allowed < 1)) throw new Error("the allowed false-alarm rate must be between 0 and 1 (for example 0.05 for one in twenty)");
    if (opts.allowed !== file.allowed) file.adjustments.push({ at: new Date().toISOString(), from: file.allowed, to: opts.allowed });
    file.allowed = opts.allowed;
  }

  // the periods to replay: complete ones with a baseline before them, the newest `max`, without the incidents the person recorded
  const all = await deps.periods();
  const incidents = incidentWindows(opts.workspace, opts.kpi);
  const candidates = all
    .slice(deps.baseline)
    .slice(-(opts.maxPeriods ?? DEFAULT_PERIODS))
    .filter((b) => !overlapsIncident(b, incidents));
  const todo = candidates.filter((b) => file!.outcomes[b.bucket] === undefined);

  // what it reads, said before anything is read on a cloud database
  if (todo.length > 0 && state.dialect === "bigquery" && !opts.goAhead) {
    const measured = file.first_bytes !== undefined;
    const per = file.first_bytes ?? (deps.tableBytes ? Math.round((await deps.tableBytes()) * SCANS_PER_PERIOD) : 0);
    const total = per * todo.length;
    if (total > GO_AHEAD_BYTES) {
      return { kpi: opts.kpi, stage: "needs_go_ahead", reasons: [], estimate: { periods: todo.length, bytes_per_period: per, total_bytes: total, measured }, progress: { done: candidates.length - todo.length, total: candidates.length }, flagged: [], not_judged: [] };
    }
  }

  const deadline = Date.now() + (opts.chunkMs ?? CHUNK_MS);
  for (const b of [...todo].reverse()) {
    // newest first: a partial replay is about the periods that matter most
    const { result, stopped, bytes } = await deps.runOne(b);
    const base = { period: b.bucket, start: b.bucket_start.slice(0, 10), end: b.bucket_end.slice(0, 10), at: new Date().toISOString(), ...(bytes !== undefined ? { bytes } : {}) };
    if (!result) file.outcomes[b.bucket] = { ...base, status: "not_judged", alarm: false, why: [], reason: stopped ?? "it could not be run" };
    else if (result.status !== "complete") file.outcomes[b.bucket] = { ...base, status: "not_judged", alarm: false, why: [], reason: result.stopped_reason ? `${result.stopped_reason}${result.stopped_detail ? `: ${result.stopped_detail}` : ""}` : "it stopped" };
    else {
      const a = alarmOf(result);
      file.outcomes[b.bucket] = { ...base, status: "judged", alarm: a.alarm, why: a.why };
    }
    if (file.first_bytes === undefined && bytes !== undefined && bytes > 0) file.first_bytes = bytes;
    writeFile(opts.workspace, file);
    if (Date.now() >= deadline && Object.keys(file.outcomes).length < candidates.length) break;
  }
  writeFile(opts.workspace, file);

  const have = candidates.filter((b) => file!.outcomes[b.bucket] !== undefined);
  const outcomes = have.map((b) => file!.outcomes[b.bucket]);
  const progress = { done: have.length, total: candidates.length };
  const ev = evaluate(outcomes, file.labels, file.allowed);
  const flagged = ev.flagged.map((o) => ({ period: o.period, words: dayWords(o.start, o.end), what: o.why }));
  const notJudged = outcomes.filter((o) => o.status === "not_judged").map((o) => ({ period: o.period, words: dayWords(o.start, o.end), reason: o.reason ?? "" }));
  if (have.length < candidates.length) return { kpi: opts.kpi, stage: "running", reasons: [], progress, evaluation: ev, flagged, not_judged: notJudged };

  // every period has an outcome: record the verdict on the KPI
  let level: Level = levelOf(rec);
  const pending = ev.flagged.length;
  updateState(opts.workspace, (s) => {
    const k = s.kpis[opts.kpi];
    const before = levelOf(k);
    k.calibration = { at: new Date().toISOString(), pass: ev.pass, false_alarm_rate: ev.rate, allowed: ev.allowed, quiet_periods: ev.judged, ...(k.calibration?.hit_rate !== undefined ? { hit_rate: k.calibration.hit_rate } : {}) };
    k.level = levelOf(k);
    level = k.level;
    logChange(s, `kpi:${opts.kpi}`, before, level, ev.pass ? `${ev.alarms} of ${ev.judged} ordinary periods raised something (${sayRate(ev.rate)}), within the ${sayRate(ev.allowed)} allowed` : ev.enough ? `${ev.alarms} of ${ev.judged} ordinary periods raised something (${sayRate(ev.rate)}), more than the ${sayRate(ev.allowed)} allowed` : `only ${ev.judged} ordinary periods could be judged; ${MIN_JUDGED} are needed`, "calibrate");
  });
  syncExperts(opts.workspace, opts.kpi, level, `calibration ${ev.pass ? "passed" : "did not pass"}`, "calibrate");
  void pending;
  return { kpi: opts.kpi, stage: "done", reasons: [], progress, evaluation: ev, flagged, not_judged: notJudged, level, gap: levelGap(readState(opts.workspace)!.kpis[opts.kpi]) };
}

/** The person says whether something real happened in a period that raised something. A real one stops counting against the KPI. */
export function labelPeriod(workspace: string, kpi: string, period: string, real: boolean, note?: string): { period: string; real: boolean; evaluation: Evaluation } {
  const file = readFile(workspace, kpi);
  if (!file) throw new Error(`${kpi} has not been replayed yet; run the calibration first`);
  if (file.outcomes[period] === undefined) throw new Error(`${period} was not one of the replayed periods (have: ${Object.keys(file.outcomes).slice(0, 6).join(", ")}${Object.keys(file.outcomes).length > 6 ? ", ..." : ""})`);
  file.labels[period] = { real, ...(note ? { note } : {}), at: new Date().toISOString() };
  writeFile(workspace, file);
  return { period, real, evaluation: evaluate(Object.values(file.outcomes), file.labels, file.allowed) };
}

/** Where a KPI's calibration stands, from what is kept. */
export function calibrationStatus(workspace: string, kpi: string): { replayed: boolean; evaluation?: Evaluation; known_events: { period: string; words: string; note?: string }[]; allowed?: number; adjustments: CalibrationFile["adjustments"] } {
  const file = readFile(workspace, kpi);
  if (!file) return { replayed: false, known_events: [], adjustments: [] };
  const events = Object.entries(file.labels)
    .filter(([, l]) => l.real)
    .map(([period, l]) => ({ period, words: file.outcomes[period] ? dayWords(file.outcomes[period].start, file.outcomes[period].end) : period, ...(l.note ? { note: l.note } : {}) }));
  return { replayed: true, evaluation: evaluate(Object.values(file.outcomes), file.labels, file.allowed), known_events: events, allowed: file.allowed, adjustments: file.adjustments };
}
