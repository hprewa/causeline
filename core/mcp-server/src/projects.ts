import { basename, join, resolve } from "node:path";
import { createProject, driftCheck, findProject, listProjects, openProject, projectsHome, projectSummary, readState } from "@causeline/builder";
import type { ServerConfig } from "./config.js";
import type { Callers } from "./handlers.js";

/** The registered name of the open project, if it is one. */
export function openProjectName(cfg: ServerConfig): string | undefined {
  if (cfg.packDir === "") return undefined;
  return listProjects(cfg.home ?? projectsHome()).find((p) => resolve(p.folder) === resolve(cfg.packDir))?.name;
}

/**
 * The projects the person has, and which one is open. Opening or creating one changes what every other tool works on: the server's
 * folder, where results go, the data connection that was started for the old one, and the question being built.
 */
export class ProjectService {
  constructor(
    private readonly cfg: ServerConfig,
    private readonly callers: Callers,
    private readonly onSwitch: () => void,
  ) {}

  private get home(): string {
    return this.cfg.home ?? projectsHome();
  }

  private openName(): string | undefined {
    return openProjectName(this.cfg);
  }

  list() {
    const open = this.openName();
    return {
      open: this.cfg.packDir === "" ? null : (open ?? basename(this.cfg.packDir)),
      projects: listProjects(this.home).map((p) => ({ name: p.name, last_opened: p.last_opened ?? null, ...(p.missing ? { missing: true } : {}), open: p.name === open })),
      note: "Names only: never show the user a folder path. Open one by name with open_project, or make a new one with create_project.",
    };
  }

  private async switchTo(folder: string): Promise<void> {
    this.cfg.packDir = folder;
    if (!this.cfg.runsFixed) this.cfg.runsDir = join(folder, "runs");
    await this.callers.reset?.();
    this.onSwitch();
  }

  async create(name: string) {
    const entry = createProject(this.home, name);
    await this.switchTo(entry.folder);
    return { created: entry.name, ...this.summary() };
  }

  /** Open a project, and work its stored numbers out again before anything is answered from it. */
  async open(name: string) {
    const entry = openProject(this.home, name);
    await this.switchTo(entry.folder);
    const drift = await this.drift(entry.folder);
    return { opened: entry.name, ...(drift ? { drift } : {}), ...this.summary() };
  }

  private async drift(folder: string): Promise<{ ok: boolean; detail: string; changed?: { kpi: string; before: string; after: string }[] } | undefined> {
    const kpis = Object.values(readState(folder)?.kpis ?? {});
    if (!kpis.some((k) => k.checks.some((c) => c.state === "confirmed" && c.window.start !== ""))) return undefined;
    try {
      const r = await driftCheck({ workspace: folder, tools: await this.callers.caller() });
      return { ok: r.ok, detail: r.detail, ...(r.changed.length > 0 ? { changed: r.changed.map((c) => ({ kpi: c.kpi, before: c.before, after: c.after })) } : {}) };
    } catch (e) {
      return { ok: false, detail: `the stored numbers could not be worked out again (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); nothing was changed` };
    }
  }

  /** The open project, or the one named. */
  summary(name?: string) {
    if (name) {
      const p = findProject(this.home, name);
      if (p.missing) throw new Error(`the folder for "${p.name}" is gone; it may have been moved or deleted`);
      return projectSummary(p.folder, p.name);
    }
    if (this.cfg.packDir === "") throw new Error("no project is open. Call create_project with a name, or list_projects and open_project.");
    return projectSummary(this.cfg.packDir, this.openName() ?? basename(this.cfg.packDir));
  }
}
