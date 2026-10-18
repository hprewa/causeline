#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { Ontology } from "./ontology.js";
import { DataDefs } from "./data.js";
import { ToolsMeta } from "./meta.js";
import { Playbook } from "./playbook.js";
import { Result } from "./result.js";
import { EvalCase, EvalCases } from "./evalcase.js";

const SCHEMAS = {
  ontology: Ontology,
  data: DataDefs,
  toolsmeta: ToolsMeta,
  playbook: Playbook,
  result: Result,
  evalcase: EvalCase,
  evalcases: EvalCases,
} as const;

type SchemaName = keyof typeof SCHEMAS;

function usage(): never {
  console.error("usage: causeline-validate <file.yaml|file.json> --as <ontology|data|toolsmeta|playbook|result|evalcase|evalcases>");
  process.exit(2);
}

function parseArgs(argv: string[]): { file: string; as: SchemaName } {
  const asIdx = argv.indexOf("--as");
  if (asIdx === -1 || asIdx + 1 >= argv.length) usage();
  const as = argv[asIdx + 1];
  const file = argv.find((a, i) => i !== asIdx && i !== asIdx + 1 && !a.startsWith("--"));
  if (!file || !(as in SCHEMAS)) usage();
  return { file, as: as as SchemaName };
}

function main(): void {
  const { file, as } = parseArgs(process.argv.slice(2));
  const raw = readFileSync(file, "utf-8");
  const data = file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);

  const schema = SCHEMAS[as];
  const result = schema.safeParse(data);

  if (result.success) {
    console.log(`OK: ${file} is a valid ${as}`);
    process.exit(0);
  }

  console.error(`FAILED: ${file} is not a valid ${as}`);
  for (const issue of result.error.issues) {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    console.error(`  ${path}: ${issue.message}`);
  }
  process.exit(1);
}

main();
