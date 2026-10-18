import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvalCase } from "@causeline/schema";

export interface PrepareArgs {
  /** The case's setup string (for example, fault flags for a synthetic data generator). */
  setup: string;
  /** Empty or stale directory to build a complete, self-contained pack in. */
  workDir: string;
  /** The pack the cases belong to. */
  packDir: string;
  /** Skip the work if workDir already holds a pack built from the same setup. */
  reuse: boolean;
}

/**
 * Build a pack for one eval case. The contract is pack-supplied so the core
 * knows nothing about how any pack makes its data: `<pack>/evals/prepare.mjs`
 * default-exports `async (args: PrepareArgs) => void` and leaves a complete
 * pack (ontology, toolbox config, data) in `workDir`.
 */
export async function prepareCase(packDir: string, c: EvalCase, workRoot: string, reuse: boolean): Promise<string> {
  // a case with no setup is about the pack's own data: nothing to build
  if (c.setup === undefined) return resolve(packDir);
  const script = resolve(packDir, "evals", "prepare.mjs");
  if (!existsSync(script)) throw new Error(`pack has no evals/prepare.mjs (looked at ${script})`);
  const mod = (await import(pathToFileURL(script).href)) as { default?: (a: PrepareArgs) => Promise<void> };
  if (typeof mod.default !== "function") throw new Error(`${script} must default-export an async function`);
  const workDir = resolve(join(workRoot, c.id));
  await mod.default({ setup: c.setup, workDir, packDir: resolve(packDir), reuse });
  return workDir;
}
