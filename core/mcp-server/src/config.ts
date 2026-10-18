import { join } from "node:path";

export interface ServerConfig {
  /** The pack to serve: a directory holding ontology.yaml and toolbox/. */
  packDir: string;
  /** Path to the Toolbox binary; otherwise found on PATH or at the repo root. */
  toolboxBinary?: string;
  /** Use a Toolbox that is already running instead of starting one. */
  toolboxUrl?: string;
  /** Core playbooks directory; required when running from a bundle. */
  corePlaybooksDir?: string;
  /** Where result.json files are written. */
  runsDir: string;
}

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);

/**
 * Configuration comes from the environment so every MCP client, plugin or
 * hand-written config, sets it the same way:
 *   CAUSELINE_PACK          the pack directory (default: the client's project directory, then the cwd)
 *   CAUSELINE_TOOLBOX       the Toolbox binary
 *   CAUSELINE_TOOLBOX_URL   an already-running Toolbox (causeline-mcp then starts none)
 *   CAUSELINE_PLAYBOOKS     the core playbooks directory
 *   CAUSELINE_RUNS          where result.json files go (default: <pack>/runs)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ServerConfig {
  const packDir = nonEmpty(env.CAUSELINE_PACK) ?? nonEmpty(env.CLAUDE_PROJECT_DIR) ?? cwd;
  return {
    packDir,
    toolboxBinary: nonEmpty(env.CAUSELINE_TOOLBOX),
    toolboxUrl: nonEmpty(env.CAUSELINE_TOOLBOX_URL),
    corePlaybooksDir: nonEmpty(env.CAUSELINE_PLAYBOOKS),
    runsDir: nonEmpty(env.CAUSELINE_RUNS) ?? join(packDir, "runs"),
  };
}
