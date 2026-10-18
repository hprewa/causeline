import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGenerated } from "@causeline/generate";
import { loadAgents, loadPack, validatePack } from "@causeline/schema";

/**
 * build.json: what has been done to a workspace so far, so a conversation can stop and a new one pick up
 * where it left off. The tools write it; the agent never does.
 */
export interface BuildState {
  version: 1;
  created: string;
  /** The Toolbox source name written into data.yaml. */
  source: string;
  tables: { name: string; file: string; rows: number; columns: number; notes: string[] }[];
  profiled: boolean;
  /** Per KPI: how far it has been taken. `reconciled` means its number matched one the user knows. */
  kpis: Record<string, { status: "drafted" | "tested" | "reconciled"; reconciled?: { period: string; expected: number; got: number; tolerance: number } }>;
  seasonality: "not_run" | "confirmed" | "none";
  /** The seasonality analysis has been run, so what the saved description says about repeating patterns is a decision. */
  seasonalityAnalysed?: boolean;
  incidents: { id: string; kpi: string; text: string }[];
  /** The sentences the user has confirmed (by number and text), so a later change is shown against them. */
  confirmed: string[];
}

const FILE = "build.json";

export function newState(source: string): BuildState {
  return { version: 1, created: new Date().toISOString(), source, tables: [], profiled: false, kpis: {}, seasonality: "not_run", incidents: [], confirmed: [] };
}

export function readState(workspace: string): BuildState | null {
  const p = join(workspace, FILE);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as BuildState) : null;
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
    const s = state.kpis[k]?.status ?? "drafted";
    steps.push({ step: `KPI ${k} matches a number you know`, done: s === "reconciled", detail: s });
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
  return { steps, next: first ? (next[first.step] ?? `Ask the user for the number for ${first.step.replace("KPI ", "").split(" ")[0]} and reconcile it.`) : "Everything is in place: answers can be called verified once the incident cases pass (verify_expert)." };
}
