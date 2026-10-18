import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { AgentDef } from "./agent.js";
import { DataDefs } from "./data.js";
import { ToolsMeta } from "./meta.js";
import { Ontology } from "./ontology.js";

export const ONTOLOGY_FILE = "ontology.yaml";
export const DATA_FILE = "data.yaml";
/** At the pack root, deliberately outside `toolbox/`: Toolbox parses every file in its config folder and rejects unknown fields. */
export const META_FILE = "tools.meta.yaml";

export interface PackDefinition {
  dir: string;
  ontology: Ontology;
  data: DataDefs;
  /** Absent until the tools have been generated. */
  meta?: ToolsMeta;
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  return parse(readFileSync(path, "utf-8"));
}

function describe(file: string, issues: { path: (string | number)[]; message: string }[]): string {
  return `${file} is not valid:\n` + issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

/** Read and parse a pack's three definition files, with errors that name the file and the field. */
export function loadPack(dir: string, opts: { requireMeta?: boolean } = {}): PackDefinition {
  const ont = Ontology.safeParse(readYaml(join(dir, ONTOLOGY_FILE)));
  if (!ont.success) throw new Error(describe(join(dir, ONTOLOGY_FILE), ont.error.issues));
  const data = DataDefs.safeParse(readYaml(join(dir, DATA_FILE)));
  if (!data.success) throw new Error(describe(join(dir, DATA_FILE), data.error.issues));
  let meta: ToolsMeta | undefined;
  const metaPath = join(dir, META_FILE);
  if (existsSync(metaPath)) {
    const m = ToolsMeta.safeParse(readYaml(metaPath));
    if (!m.success) throw new Error(describe(metaPath, m.error.issues));
    meta = m.data;
  } else if (opts.requireMeta) {
    throw new Error(`${metaPath} does not exist; run \`causeline generate --pack ${dir}\``);
  }
  return { dir, ontology: ont.data, data: data.data, meta };
}

/** The pack's own experts (agents/*.yaml). A pack with none still has the generic experts the router adds. */
export function loadAgents(dir: string): AgentDef[] {
  const folder = join(dir, "agents");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const parsed = AgentDef.safeParse(readYaml(join(folder, f)));
      if (!parsed.success) throw new Error(describe(join(folder, f), parsed.error.issues));
      return parsed.data;
    });
}
