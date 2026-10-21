import { basename, join, resolve } from "node:path";
import { createProject, findProject, listProjects, openProject, projectsHome, projectSummary } from "@causeline/builder";
import type { ServerConfig } from "./config.js";
import type { Callers } from "./handlers.js";

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

  /** The registered name of the open project, if it is one. */
  private openName(): string | undefined {
    if (this.cfg.packDir === "") return undefined;
    return listProjects(this.home).find((p) => resolve(p.folder) === resolve(this.cfg.packDir))?.name;
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

  async open(name: string) {
    const entry = openProject(this.home, name);
    await this.switchTo(entry.folder);
    return { opened: entry.name, ...this.summary() };
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
