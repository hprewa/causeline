import { existsSync } from "node:fs";
import { join } from "node:path";
import { lastProject, projectsHome } from "@causeline/builder";

export interface ServerConfig {
  /** The project being served: a directory holding ontology.yaml and toolbox/ (or a build in progress). Empty when no project is open. */
  packDir: string;
  /** Path to the Toolbox binary; otherwise found on PATH or at the repo root. */
  toolboxBinary?: string;
  /** Use a Toolbox that is already running instead of starting one. */
  toolboxUrl?: string;
  /** Core playbooks directory; required when running from a bundle. */
  corePlaybooksDir?: string;
  /** Where result.json files are written. */
  runsDir: string;
  /** Where projects live (the registry and, by default, every project folder). */
  home?: string;
  /** Results go to CAUSELINE_RUNS whichever project is open (otherwise to the open project's own runs folder). */
  runsFixed?: boolean;
}

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
const holdsProject = (dir: string | undefined) => !!dir && (existsSync(join(dir, "ontology.yaml")) || existsSync(join(dir, "build.json")));

/**
 * Configuration comes from the environment so every MCP client, plugin, desktop extension or hand-written config, sets it the same way:
 *   CAUSELINE_HOME          where projects live (default: a Causeline folder in the person's home)
 *   CAUSELINE_PACK          one fixed pack directory (an engineer's override; projects can still be opened)
 *   CAUSELINE_TOOLBOX       the Toolbox binary
 *   CAUSELINE_TOOLBOX_URL   an already-running Toolbox (causeline-mcp then starts none)
 *   CAUSELINE_PLAYBOOKS     the core playbooks directory
 *   CAUSELINE_RUNS          where result.json files go (default: <project>/runs)
 *
 * Which project is open at the start: CAUSELINE_PACK; else the client's project folder or the working folder if it already holds a project;
 * else the project opened last; else the client's project folder (a fresh build there); else none, and the person is asked to create one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ServerConfig {
  const home = projectsHome(env);
  const client = nonEmpty(env.CLAUDE_PROJECT_DIR);
  const packDir = nonEmpty(env.CAUSELINE_PACK) ?? [client, cwd].find(holdsProject) ?? lastProject(home)?.folder ?? client ?? "";
  const runs = nonEmpty(env.CAUSELINE_RUNS);
  return {
    packDir,
    toolboxBinary: nonEmpty(env.CAUSELINE_TOOLBOX),
    toolboxUrl: nonEmpty(env.CAUSELINE_TOOLBOX_URL),
    corePlaybooksDir: nonEmpty(env.CAUSELINE_PLAYBOOKS),
    runsDir: runs ?? (packDir ? join(packDir, "runs") : ""),
    home,
    runsFixed: !!runs,
  };
}
