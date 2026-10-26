import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atLeast, loadAgents, loadPack, type Rung, type StatusChange } from "@causeline/schema";
import { causelineHome } from "@causeline/runner";
import { readCard } from "./setup-card.js";
import { buildStatus, levelGap, levelOf, readState, unconfirmedNumbers } from "./state.js";

/**
 * Projects: every pack the Builder makes lives in one folder under a home folder the person never has to choose, so any client (Claude Code,
 * Claude Desktop, Codex) opens the same projects. The home holds `projects.json`, a small registry from a name to a folder. Credentials are
 * never kept in a project folder.
 */

export interface ProjectEntry {
  /** The name the person gives it (for example "Weekly review"). */
  name: string;
  folder: string;
  created: string;
  last_opened?: string;
}

interface Registry {
  version: 1;
  projects: ProjectEntry[];
}

/** The folder that holds the registry and, by default, the projects: CAUSELINE_HOME, else a folder called Causeline in the person's home. */
export function projectsHome(env: NodeJS.ProcessEnv = process.env): string {
  return causelineHome(env);
}

const FILE = "projects.json";

function read(home: string): Registry {
  const p = join(home, FILE);
  if (!existsSync(p)) return { version: 1, projects: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<Registry>;
    return { version: 1, projects: Array.isArray(raw.projects) ? raw.projects : [] };
  } catch {
    throw new Error(`${p} is not readable; move it aside and the projects will be listed again from their folders`);
  }
}

function write(home: string, reg: Registry): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, FILE), JSON.stringify(reg, null, 2) + "\n", "utf-8");
}

/** A folder name made from the project's name: letters, digits and hyphens. */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "project" : slug;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface ListedProject extends ProjectEntry {
  /** The folder is no longer there (moved or deleted): the entry stays so the person can be told. */
  missing: boolean;
}

export function listProjects(home: string): ListedProject[] {
  return read(home)
    .projects.map((p) => ({ ...p, missing: !existsSync(p.folder) }))
    .sort((a, b) => (b.last_opened ?? b.created).localeCompare(a.last_opened ?? a.created));
}

/** Make a project: a new folder under the home, registered under the name. A name already in use is refused. */
export function createProject(home: string, name: string): ProjectEntry {
  const clean = name.trim();
  if (clean === "") throw new Error("a project needs a name");
  const reg = read(home);
  if (reg.projects.some((p) => sameName(p.name, clean))) throw new Error(`there is already a project called "${clean}"; open it, or choose another name`);
  let folder = join(home, slugOf(clean));
  for (let n = 2; existsSync(folder) || reg.projects.some((p) => resolve(p.folder) === resolve(folder)); n++) folder = join(home, `${slugOf(clean)}-${n}`);
  mkdirSync(folder, { recursive: true });
  const now = new Date().toISOString();
  const entry: ProjectEntry = { name: clean, folder, created: now, last_opened: now };
  reg.projects.push(entry);
  write(home, reg);
  return entry;
}

/** Put an existing folder (for example a shipped example pack) in the registry under a name. */
export function registerProject(home: string, name: string, folder: string): ProjectEntry {
  const clean = name.trim();
  if (clean === "") throw new Error("a project needs a name");
  if (!existsSync(resolve(folder))) throw new Error(`${folder} does not exist`);
  const reg = read(home);
  const existing = reg.projects.find((p) => sameName(p.name, clean));
  if (existing) {
    if (resolve(existing.folder) !== resolve(folder)) throw new Error(`there is already a project called "${clean}" in another folder`);
    return existing;
  }
  const now = new Date().toISOString();
  const entry: ProjectEntry = { name: clean, folder: resolve(folder), created: now };
  reg.projects.push(entry);
  write(home, reg);
  return entry;
}

/** Find a project by the name the person uses (case does not matter; a unique start of the name is enough). */
export function findProject(home: string, name: string): ListedProject {
  const all = listProjects(home);
  const q = name.trim().toLowerCase();
  const exact = all.filter((p) => p.name.toLowerCase() === q);
  const hits = exact.length > 0 ? exact : all.filter((p) => p.name.toLowerCase().startsWith(q));
  if (hits.length === 0) throw new Error(`there is no project called "${name}"${all.length > 0 ? ` (there are: ${all.map((p) => p.name).join(", ")})` : "; create one first"}`);
  if (hits.length > 1) throw new Error(`"${name}" could mean ${hits.map((p) => p.name).join(" or ")}; say which`);
  return hits[0];
}

/** Open a project: note when it was opened, and say plainly if its folder has gone. */
export function openProject(home: string, name: string): ProjectEntry {
  const found = findProject(home, name);
  if (found.missing) throw new Error(`the folder for "${found.name}" is gone (${found.folder}); it may have been moved or deleted`);
  const reg = read(home);
  const entry = reg.projects.find((p) => p.name === found.name)!;
  entry.last_opened = new Date().toISOString();
  write(home, reg);
  return entry;
}

/** The project opened most recently whose folder is still there, if any. */
export function lastProject(home: string): ProjectEntry | null {
  const p = listProjects(home).find((x) => !x.missing && x.last_opened);
  return p ?? null;
}

export interface ProjectSummary {
  name: string;
  folder: string;
  /** False for a project that was not built here (a shipped example): its checks are not tracked, so its experts' rungs are shown as they are written. */
  tracked: boolean;
  /** Where the setup stands, in the Builder's own words. */
  next: string;
  /** "3 of 8 setup steps done", so a returning person knows where they are. */
  progress?: string;
  data: { dialect: string; tables: { name: string; rows: number }[] };
  kpis: { kpi: string; type: string; level: Rung; unconfirmed: boolean; gap: string; calibration?: { pass: boolean; false_alarm_rate: number; allowed: number; quiet_periods: number } }[];
  experts: { name: string; kpi: string; task: string; status: Rung; unconfirmed_numbers: boolean }[];
  incidents: number;
  /** The last few changes of rung, newest last. */
  recent_changes: StatusChange[];
  /** When the stored numbers were last re-checked on opening, and what that found. */
  drift?: { at: string; ok: boolean; detail: string };
}

/** What a person needs to see when they open a project, worked out from its files. Never starts a query. */
export function projectSummary(folder: string, name?: string): ProjectSummary {
  const state = readState(folder);
  let kpis: ProjectSummary["kpis"] = [];
  let experts: ProjectSummary["experts"] = [];
  try {
    const pack = loadPack(folder);
    kpis = Object.entries(pack.ontology.metrics).map(([kpi, m]) => {
      const rec = state?.kpis[kpi];
      return { kpi, type: m.type, level: levelOf(rec), unconfirmed: unconfirmedNumbers(rec), gap: levelGap(rec), ...(rec?.calibration ? { calibration: { pass: rec.calibration.pass, false_alarm_rate: rec.calibration.false_alarm_rate, allowed: rec.calibration.allowed, quiet_periods: rec.calibration.quiet_periods } } : {}) };
    });
    experts = loadAgents(folder).map((a) => ({ name: a.name, kpi: a.kpi, task: a.task, status: a.status, unconfirmed_numbers: a.unconfirmed_numbers }));
    // a project not built here has no checks of its own on record: a KPI stands where its best expert is written to stand
    if (!state) {
      kpis = kpis.map((k) => {
        const best = experts.filter((e) => e.kpi === k.kpi).map((e) => e.status).reduce<Rung>((a, b) => (atLeast(b, a) ? b : a), "draft");
        return { ...k, level: best, gap: best === "draft" ? "no checks are recorded for it here" : "its numbers were checked outside this Builder (see the experts below)" };
      });
    }
  } catch {
    // no description saved yet: the summary says where the setup is
  }
  return {
    name: name ?? folder,
    folder,
    tracked: !!state,
    next: state ? buildStatus(folder).next : kpis.length > 0 ? "Ready for questions. This project was not built here, so its numbers and checks are not tracked." : buildStatus(folder).next,
    ...(state || readCard(folder) ? { progress: buildStatus(folder).progress } : {}),
    data: { dialect: state?.dialect ?? "sqlite", tables: (state?.tables ?? []).map((t) => ({ name: t.name, rows: t.rows })) },
    kpis,
    experts,
    incidents: state?.incidents.length ?? 0,
    recent_changes: (state?.status_log ?? []).slice(-5),
    ...(state?.drift ? { drift: state.drift } : {}),
  };
}
