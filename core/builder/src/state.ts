import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGenerated } from "@causeline/generate";
import { atLeast, loadAgents, loadPack, nextRungNeeds, validatePack, type Rung, type StatusChange } from "@causeline/schema";

/** What kind of number a check is; the first rung asks for several numbers of different kinds, from different periods. */
export type CheckKind = "total" | "slice" | "grain" | "odd_period";
/** Where a KPI stands (see `Rung` in the schema package): never set by hand, always worked out from what is stored. */
export type Level = Rung;

/** Confirmed numbers, from different periods and at least two kinds, that the first rung asks for. */
export const NUMBERS_NEEDED = 3;

/** One number the tools give for a KPI, set against the number the user knows from somewhere else. */
export interface SignoffCheck {
  id: string;
  kind: CheckKind;
  /** The part of the data it is about: `{concept: value}`; empty is the whole data. */
  scope: Record<string, string>;
  /** Whole days, both inclusive. */
  window: { start: string; end: string };
  /** The check in plain words, for the person. */
  label: string;
  /** What the tools give. Kept out of what the user is shown until they have given their own number. */
  got: number;
  /** The user's number, once given, and the named place it comes from. */
  expected?: number;
  source?: string;
  /** Relative difference allowed. */
  tolerance: number;
  /** `plausible`: the person could not give an exact figure but says the number looks right. It counts toward nothing and marks the KPI "numbers not confirmed". */
  state: "pending" | "confirmed" | "flagged" | "plausible";
  confirmed_at?: string;
  note?: string;
}

/** One automatic check the user never has to see unless it fails. */
export interface AutoResult {
  id: string;
  ok: boolean;
  /** Not run (for example the fact does not say what one row stands for). Not a pass, and not a failure. */
  skipped?: boolean;
  detail: string;
}

export interface KpiRecord {
  level: Level;
  checks: SignoffCheck[];
  /** The last run of the automatic checks; cleared whenever the KPI's formula or fact changes. */
  auto?: { at: string; pass: boolean; results: AutoResult[] };
  /**
   * Windows in which another KPI built on the same data was found far from the person's own number. The data for those days is
   * in doubt for every KPI on it, so this KPI's confirmed numbers for them are set aside (a rate can agree while the counts under it
   * are short). They come back when that other KPI's number for the window matches.
   */
  suspect?: { start: string; end: string; from_kpi: string; detail: string }[];
  /**
   * Written when a build from before the ladder was renamed is opened: the KPI had been verified under the earlier two-number rule. It stands
   * as reconciled (nothing is lost) until its formula changes or a check fails; one more number from a different period meets today's rule.
   */
  grandfathered?: { from: "verified"; at: string };
  /** Replay over ordinary past periods: the share that raised a false alarm against what the person allows. Set by calibration. */
  calibration?: { at: string; pass: boolean; false_alarm_rate: number; allowed: number; quiet_periods: number; hit_rate?: number };
  /** Known incidents the analysis was not tuned on, and faults planted in the person's own data, that it found. Set by verification. */
  verification?: { at: string; pass: boolean; incidents_passed: string[]; faults_passed?: string[] };
}

const overlaps = (c: { window: { start: string; end: string } }, s: { start: string; end: string }) => c.window.start !== "" && c.window.start <= s.end && c.window.end >= s.start;
/** The confirmed numbers that count: those for days nobody has found to be in doubt. */
const counted = (rec: KpiRecord) => rec.checks.filter((c) => c.state === "confirmed" && !(rec.suspect ?? []).some((s) => overlaps(c, s)));

/**
 * build.json: what has been done to a workspace so far, so a conversation can stop and a new one pick up
 * where it left off. The tools write it; the agent never does.
 */
export interface BuildState {
  version: 3;
  created: string;
  /** The Toolbox source name written into data.yaml. */
  source: string;
  /** Where the data lives: absent means the local database made from the user's files. */
  dialect?: "sqlite" | "bigquery";
  /** For BigQuery: the project queries are billed to, where the data is, and the dataset when one was given. */
  bigquery?: { project: string; location: string; dataset?: string };
  tables: { name: string; file: string; rows: number; columns: number; notes: string[] }[];
  profiled: boolean;
  /** Per KPI: its checks and where it stands on the ladder (draft, reconciled, calibrated, verified). */
  kpis: Record<string, KpiRecord>;
  /** Every change of rung, for a KPI or an expert: when, from what to what, why, and by which step. */
  status_log: StatusChange[];
  seasonality: "not_run" | "confirmed" | "none";
  /** The seasonality analysis has been run, so what the saved description says about repeating patterns is a decision. */
  seasonalityAnalysed?: boolean;
  incidents: { id: string; kpi: string; text: string }[];
  /** The sentences the user has confirmed (by number and text), so a later change is shown against them. */
  confirmed: string[];
}

/** The confirmed numbers that name where they come from. */
const sourced = (rec: KpiRecord) => counted(rec).filter((c) => (c.source ?? "").trim() !== "");

/** Does the KPI meet today's rule for the first rung? Several numbers, from at least two periods and two kinds, each from a named source. */
function meetsReconciliation(rec: KpiRecord): boolean {
  const s = sourced(rec);
  const kinds = new Set(s.map((c) => c.kind));
  const periods = new Set(s.filter((c) => c.window.start !== "").map((c) => `${c.window.start}..${c.window.end}`));
  return !!rec.auto?.pass && s.length >= NUMBERS_NEEDED && kinds.size >= 2 && periods.size >= 2 && !rec.checks.some((c) => c.state === "flagged");
}

/**
 * Where a KPI stands, worked out from what is stored and never set by hand.
 * - draft: saved, not enough confirmed yet, or an automatic check fails.
 * - reconciled: the automatic checks pass, nothing is flagged, and at least three numbers from at least two periods and two kinds are confirmed
 *   against named sources (or the KPI was verified under the earlier two-number rule and has not changed since: `grandfathered`).
 * - calibrated: reconciled, and a replay over ordinary past periods stayed under the false-alarm rate the person allows.
 * - verified: calibrated, and the analysis found the known incidents or planted faults it was tested on.
 */
export function levelOf(rec: KpiRecord | undefined): Level {
  if (!rec) return "draft";
  if (rec.auto && !rec.auto.pass) return "draft";
  const holds = meetsReconciliation(rec) || (!!rec.grandfathered && counted(rec).length > 0 && !rec.checks.some((c) => c.state === "flagged"));
  if (!holds) return "draft";
  if (!rec.calibration?.pass) return "reconciled";
  return rec.verification?.pass ? "verified" : "calibrated";
}

/** The KPI's numbers were only a plausible sample, not confirmed against the person's reports (it can only be a draft). */
export function unconfirmedNumbers(rec: KpiRecord | undefined): boolean {
  return !!rec && levelOf(rec) === "draft" && rec.checks.some((c) => c.state === "plausible");
}

/**
 * A KPI whose formula or fact changed: what was confirmed stays on record but is no longer vouched for. The
 * automatic checks must be run again and the numbers re-worked (run_checks) before it is reconciled again;
 * proposals nobody answered are dropped, since their figures were for the old formula. Calibration and verification
 * were of the old formula, so they go too.
 */
export function dropForChange(rec: KpiRecord | undefined): KpiRecord {
  const checks = (rec?.checks ?? []).filter((c) => c.state !== "pending" || c.expected !== undefined);
  const next: KpiRecord = { level: "draft", checks };
  next.level = levelOf(next);
  return next;
}

/** What stands between a KPI and the next step up, in plain words ("" when it is verified). */
export function levelGap(rec: KpiRecord | undefined): string {
  const level = levelOf(rec);
  if (level !== "draft") return nextRungNeeds(level);
  const confirmed = rec ? counted(rec) : [];
  const setAside = rec ? rec.checks.filter((c) => c.state === "confirmed" && !confirmed.includes(c)) : [];
  const why = setAside.length > 0 ? ` (${setAside.length} confirmed number${setAside.length === 1 ? " is" : "s are"} set aside because ${rec!.suspect![0].from_kpi} does not match the user's number for the same days: ${rec!.suspect![0].detail})` : "";
  if (rec?.auto && !rec.auto.pass) return `an automatic check fails: ${rec.auto.results.filter((r) => !r.ok && !r.skipped).map((r) => r.detail).join("; ")}`;
  if (rec?.checks.some((c) => c.state === "flagged")) return `a number is flagged (${rec.checks.filter((c) => c.state === "flagged").map((c) => c.label).join("; ")}); sort it out or leave it out`;
  if (confirmed.length === 0) return `no number has been confirmed yet${why}`;
  if (!rec?.auto) return "the automatic checks have not been run since the last change (run the checks)";
  const s = sourced(rec);
  const kinds = new Set(s.map((c) => c.kind));
  const periods = new Set(s.filter((c) => c.window.start !== "").map((c) => `${c.window.start}..${c.window.end}`));
  if (s.length < confirmed.length) return "each confirmed number needs a named source";
  const missing: string[] = [];
  if (s.length < NUMBERS_NEEDED) missing.push(`${NUMBERS_NEEDED - s.length} more confirmed number${NUMBERS_NEEDED - s.length === 1 ? "" : "s"}`);
  if (kinds.size < 2) missing.push(`a number of a different kind from ${[...kinds].join(", ")}`);
  if (periods.size < 2) missing.push("a number for a different period");
  return `needs ${missing.join(", ")}, each from a named source${why}`;
}

/** Record a change of rung in the log when the rung differs. Returns whether it did. */
export function logChange(state: BuildState, subject: string, from: Rung, to: Rung, why: string, by: string): boolean {
  if (from === to) return false;
  state.status_log.push({ at: new Date().toISOString(), subject, from, to, why, by });
  return true;
}

const FILE = "build.json";

export function newState(source: string): BuildState {
  return { version: 3, created: new Date().toISOString(), source, tables: [], profiled: false, kpis: {}, status_log: [], seasonality: "not_run", incidents: [], confirmed: [] };
}

/**
 * Open a build written by an earlier version. Version 1 (one number per KPI, `reconciled`) becomes version 2 (that number is one confirmed
 * total); version 2 (the ladder draft, provisional, verified) becomes version 3 (draft, reconciled, calibrated, verified):
 * - a KPI that was verified keeps standing as reconciled (`grandfathered`) until it changes, since it had passed the earlier, lighter rule;
 * - a KPI that was provisional (one number matched) is a draft that now needs three numbers from different periods;
 * - each such change is written to the status log so it can be seen.
 */
function upgrade(raw: Record<string, unknown>): BuildState {
  if (raw.version === 3) return { status_log: [], ...(raw as object) } as unknown as BuildState;
  let kpis: Record<string, KpiRecord>;
  if (raw.version === 2) {
    kpis = (raw.kpis ?? {}) as Record<string, KpiRecord>;
  } else {
    const old = (raw.kpis ?? {}) as Record<string, { status?: string; reconciled?: { period: string; expected: number; got: number; tolerance: number } }>;
    kpis = {};
    for (const [k, v] of Object.entries(old)) {
      const r = v.reconciled;
      kpis[k] =
        v.status === "reconciled" && r
          ? { level: "provisional" as unknown as Level, checks: [{ id: "total-1", kind: "total", scope: {}, window: { start: "", end: "" }, label: `Whole data, ${r.period} (matched before sign-off checks existed)`, got: r.got, expected: r.expected, source: "an earlier match", tolerance: r.tolerance, state: "confirmed" }] }
          : { level: "draft", checks: [] };
    }
  }
  const at = new Date().toISOString();
  const status_log: StatusChange[] = [...((raw.status_log as StatusChange[] | undefined) ?? [])];
  for (const [name, rec] of Object.entries(kpis)) {
    const was = rec.level as unknown as string;
    if (was === "verified") rec.grandfathered = { from: "verified", at };
    const now = levelOf(rec);
    rec.level = now;
    if (was === "verified" || was === "provisional") {
      status_log.push({
        at,
        subject: `kpi:${name}`,
        from: was === "verified" ? "reconciled" : "draft",
        to: now,
        why: was === "verified" ? "moved to the new ladder: verified under the earlier two-number rule stands as reconciled until the KPI changes" : "moved to the new ladder: provisional (one matched number) is a draft that needs three numbers from different periods",
        by: "migration",
      });
    }
  }
  return { ...(raw as object), version: 3, kpis, status_log } as unknown as BuildState;
}

export function readState(workspace: string): BuildState | null {
  const p = join(workspace, FILE);
  return existsSync(p) ? upgrade(JSON.parse(readFileSync(p, "utf-8"))) : null;
}

export function writeState(workspace: string, state: BuildState): void {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, FILE), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function updateState(workspace: string, change: (s: BuildState) => void): BuildState {
  const s = readState(workspace);
  if (!s) throw new Error(`${workspace} has not been set up yet; connect the files first`);
  change(s);
  writeState(workspace, s);
  return s;
}

export interface Step {
  step: string;
  done: boolean;
  detail: string;
}

export interface BuildStatus {
  steps: Step[];
  /** The one thing to do next, in plain words. */
  next: string;
}

/** The checklist, worked out live from the files as well as from build.json, with the next step. */
/** The analysis has been run: from now on the saved description's answer about repeating patterns counts as decided. */
export function markSeasonalityAnalysed(workspace: string): void {
  if (!readState(workspace)) return;
  updateState(workspace, (s) => {
    s.seasonalityAnalysed = true;
    if (s.seasonality === "not_run") s.seasonality = "none";
  });
}

export function buildStatus(workspace: string): BuildStatus {
  const state = readState(workspace);
  if (!state) return { steps: [{ step: "connect your files", done: false, detail: "nothing has been connected yet" }], next: "Connect the user's files (CSV)." };

  const steps: Step[] = [];
  steps.push({ step: "files connected", done: state.tables.length > 0, detail: state.tables.map((t) => `${t.name} (${t.rows} rows)`).join(", ") || "none" });
  steps.push({ step: "data looked at", done: state.profiled, detail: state.profiled ? "profiled" : "run describe_data" });

  let valid = false;
  let detail = "no model saved yet";
  let kpis: string[] = [];
  if (existsSync(join(workspace, "ontology.yaml")) && existsSync(join(workspace, "data.yaml"))) {
    try {
      const pack = loadPack(workspace);
      const issues = validatePack({ ontology: pack.ontology, data: pack.data, agents: loadAgents(workspace) });
      valid = issues.errors.length === 0;
      detail = valid ? "valid" : issues.errors.slice(0, 3).join("; ");
      kpis = Object.entries(pack.ontology.metrics).filter(([, m]) => m.type !== "product").map(([n]) => n);
    } catch (e) {
      detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    }
  }
  steps.push({ step: "business described and saved", done: valid, detail });
  const fresh = valid ? checkGenerated(workspace) : "missing";
  steps.push({ step: "query tools generated", done: fresh === "fresh", detail: fresh });
  for (const k of kpis) {
    const rec = state.kpis[k];
    const level = levelOf(rec);
    steps.push({ step: `KPI ${k} checked against numbers you know`, done: atLeast(level, "reconciled"), detail: atLeast(level, "reconciled") ? level : `${level}: ${levelGap(rec)}` });
  }
  steps.push({ step: "repeating patterns decided", done: state.seasonality !== "not_run", detail: state.seasonality });
  steps.push({ step: "a past incident recorded", done: state.incidents.length > 0, detail: `${state.incidents.length} recorded` });

  const first = steps.find((s) => !s.done);
  const next: Record<string, string> = {
    "files connected": "Connect the user's files (CSV).",
    "data looked at": "Run describe_data and read what it suggests.",
    "business described and saved": "Describe the business: draft the model, test each fact, save it, and play it back for the user to confirm.",
    "query tools generated": "Generate the query tools.",
    "repeating patterns decided": "Run analyze_seasonality and explain the result; then record the decision.",
    "a past incident recorded": "Ask for one past incident the user knows the cause of, and record it.",
  };
  return { steps, next: first ? (next[first.step] ?? `Take ${first.step.replace("KPI ", "").split(" ")[0]} up the ladder: propose checks, ask the user for the numbers from their own reports, and confirm them (or open the sign-off screen).`) : "Everything is in place for the first rung (reconciled). Testing against the recorded incident (verify_expert) comes next; calibrating it over ordinary past periods and then testing it against incidents make it verified." };
}
