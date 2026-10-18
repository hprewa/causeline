import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPack, META_FILE } from "@causeline/schema";
import { generateTools, renderMeta, renderYaml, type Generated } from "./generate.js";

export const GENERATED_FILE = "tools.generated.yaml";

export interface PackGeneration {
  path: string;
  metaPath: string;
  yaml: string;
  metaYaml: string;
  generated: Generated;
}

/** What the pack's generated files should contain, without writing anything. */
export function renderForPack(packDir: string): { yaml: string; metaYaml: string; generated: Generated } {
  const { ontology, data } = loadPack(packDir);
  const generated = generateTools(ontology, data);
  return { yaml: renderYaml(generated.tools, data.source), metaYaml: renderMeta(generated.meta), generated };
}

/**
 * Generate <pack>/toolbox/tools.generated.yaml and <pack>/tools.meta.yaml from ontology.yaml and data.yaml.
 * Toolbox hot-reloads its folder; the sidecar is read by the runner.
 */
export function generateForPack(packDir: string, opts: { out?: string } = {}): PackGeneration {
  const { yaml, metaYaml, generated } = renderForPack(packDir);
  const path = opts.out ?? join(packDir, "toolbox", GENERATED_FILE);
  const metaPath = join(packDir, META_FILE);
  writeFileSync(path, yaml, "utf-8");
  writeFileSync(metaPath, metaYaml, "utf-8");
  return { path, metaPath, yaml, metaYaml, generated };
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");

/** Are the generated files there, and are they what the current definition files would produce? */
export function checkGenerated(packDir: string): "fresh" | "stale" | "missing" {
  const path = join(packDir, "toolbox", GENERATED_FILE);
  const metaPath = join(packDir, META_FILE);
  if (!existsSync(path) || !existsSync(metaPath)) return "missing";
  const want = renderForPack(packDir);
  return norm(readFileSync(path, "utf-8")) === norm(want.yaml) && norm(readFileSync(metaPath, "utf-8")) === norm(want.metaYaml) ? "fresh" : "stale";
}
