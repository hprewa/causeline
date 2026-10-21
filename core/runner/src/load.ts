import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadPack, Playbook, type PackDefinition } from "@causeline/schema";
import { checkPlaybook } from "./validate.js";

/** The pack's ontology, data definition and (once generated) tool index. The runner needs the index to find tools. */
export function loadPackForRun(packDir: string): PackDefinition & { meta: NonNullable<PackDefinition["meta"]> } {
  const pack = loadPack(packDir, { requireMeta: true });
  return { ...pack, meta: pack.meta! };
}

/** The core playbooks shipped in this repo, found relative to the compiled runner. Bundles must pass their own. */
export function defaultPlaybooksDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "playbooks");
}

/** A pack's own playbook wins over a core playbook of the same name. */
export function loadPlaybook(name: string, packDir: string, coreDir?: string): Playbook {
  const core = coreDir ?? defaultPlaybooksDir();
  const candidates = [join(packDir, "playbooks", `${name}.yaml`), join(core, `${name}.yaml`)];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`playbook "${name}" not found; looked in:\n  ${candidates.join("\n  ")}`);
  const playbook = Playbook.parse(parse(readFileSync(found, "utf-8")));
  const problems = checkPlaybook(playbook);
  if (problems.length > 0) throw new Error(`playbook "${name}" (${found}) is not valid: ${problems.join("; ")}`);
  return playbook;
}
