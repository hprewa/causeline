import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGenerated } from "@causeline/generate";
import { loadAgents, loadPack, validatePack } from "@causeline/schema";

/** What kind of number a check is; two confirmed numbers of different kinds are what `verified` asks for. */
export type CheckKind = "total" | "slice" | "grain" | "odd_period";
export type Level = "draft" | "provisional" | "verified";

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
  state: "pending" | "confirmed" | "flagged";
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
}

/**
 * build.json: what has been done to a workspace so far, so a conversation can stop and a new one pick up
 * where it left off. The tools write it; the agent never does.
 */
export interface BuildState {
  version: 2;
  created: string;
  /** The Toolbox source name written into data.yaml. */
  source: string;
  tables: { name: string; file: string; rows: number; columns: number; notes: string[] }[];
  profiled: boolean;
  /** Per KPI: its checks and where it stands on the ladder (draft, provisional, verified). */
  kpis: Record<string, KpiRecord>;
  seasonality: "not_run" | "confirmed" | "none";
  /** The seasonality analysis has been run, so what the saved description says about repeating patterns is a decision. */
  seasonalityAnalysed?: boolean;
  incidents: { id: string; kpi: string; text: string }[];
  /** The sentences the user has confirmed (by number and text), so a later change is shown against them. */
  confirmed: string[];
}

/**
 * Where a KPI stands, worked out from what is stored and never set by hand.
 * - draft: saved, nothing confirmed, or an automatic check fails.
 * - provisional: at least one number confirmed (and no automatic check fails; after a change they have not been run again).
 * - verified: the automatic checks pass, nothing is flagged, and at least two confirmed numbers of different kinds
 *   each name where they come from.
 */
export function levelOf(rec: KpiRecord | undefined): Level {
  if (!rec) return "draft";
  const confirmed = rec.checks.filter((c) => c.state === "confirmed");
  if (confirmed.length === 0) return "draft";
  if (!rec.auto) return "provisional";
  if (!rec.auto.pass) return "draft";
  const kinds = new Set(confirmed.filter((c) => (c.source ?? "").trim() !== "").map((c) => c.kind));
  return kinds.size >= 2 && !rec.checks.some((c) => c.state === "flagged") ? "verified" : "provisional";
}

/**
 * A KPI whose formula or fact changed: what was confirmed stays on record but is no longer vouched for. The
 * automatic checks must be run again and the numbers re-worked (run_checks) before it is more than provisional;
 * proposals nobody answered are dropped, since their figures were for the old formula.
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
  if (level === "verified") return "";
  const confirmed = (rec?.checks ?? []).filter((c) => c.state === "confirmed");
  if (rec?.auto && !rec.auto.pass) return `an automatic check fails: ${rec.auto.results.filter((r) => !r.ok && !r.skipped).map((r) => r.detail).join("; ")}`;
  if (confirmed.length === 0) return "no number has been confirmed yet";
  if (!rec?.auto) return "the automatic checks have not been run since the last change (run the checks)";
  if (rec.checks.some((c) => c.state === "flagged")) return `a number is flagged (${rec.checks.filter((c) => c.state === "flagged").map((c) => c.label).join("; ")}); sort it out or leave it out`;
  const kinds = new Set(confirmed.map((c) => c.kind));
  return kinds.size < 2 ? `needs one more confirmed number of a different kind from ${[...kinds].join(", ")}, from a named source` : "each confirmed number needs a named source";
}

const FILE = "build.json";

export function newState(source: string): BuildState {
  return { version: 2, created: new Date().toISOString(), source, tables: [], profiled: false, kpis: {}, seasonality: "not_run", incidents: [], confirmed: [] };
}

/** A version 1 file (one number per KPI, `reconciled`) read as version 2: that number becomes one confirmed total. */
function upgrade(raw: Record<string, unknown>): BuildState {
  if (raw.version === 2) return raw as unknown as BuildState;
  const old = (raw.kpis ?? {}) as Record<string, { status?: string; reconciled?: { period: string; expected: number; got: number; tolerance: number } }>;
  const kpis: Record<string, KpiRecord> = {};
  for (const [k, v] of Object.entries(old)) {
    const r = v.reconciled;
    kpis[k] =
      v.status === "reconciled" && r
        ? { level: "provisional", checks: [{ id: "total-1", kind: "total", scope: {}, window: { start: "", end: "" }, label: `Whole data, ${r.period} (matched before sign-off checks existed)`, got: r.got, expected: r.expected, source: "an earlier match", tolerance: r.tolerance, state: "confirmed" }] }
        : { level: "draft", checks: [] };
  }
  return { ...(raw as object), version: 2, kpis } as BuildState;
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
    steps.push({ step: `KPI ${k} checked against numbers you know`, done: level === "verified", detail: level === "verified" ? "verified" : `${level}: ${levelGap(rec)}` });
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
  return { steps, next: first ? (next[first.step] ?? `Take ${first.step.replace("KPI ", "").split(" ")[0]} up the ladder: propose checks, ask the user for the numbers from their own reports, and confirm them (or open the sign-off screen).`) : "Everything is in place: answers can be called verified once the incident cases pass (verify_expert)." };
}
