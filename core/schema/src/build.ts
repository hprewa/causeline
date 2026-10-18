import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Ontology } from "./ontology.js";
import { DataDefs } from "./data.js";
import { ToolsMeta } from "./meta.js";
import { Playbook } from "./playbook.js";
import { Result } from "./result.js";
import { EvalCase } from "./evalcase.js";

// Zod is the source of truth (see src/*.ts); this writes the four JSON
// Schema files the build spec asks for, into dist/ alongside the
// compiled JS, so language-neutral pack authors have something to read
// without needing TypeScript.
const here = dirname(fileURLToPath(import.meta.url));

const schemas: Record<string, unknown> = {
  ontology: zodToJsonSchema(Ontology, "ontology"),
  data: zodToJsonSchema(DataDefs, "data"),
  toolsmeta: zodToJsonSchema(ToolsMeta, "toolsmeta"),
  playbook: zodToJsonSchema(Playbook, "playbook"),
  result: zodToJsonSchema(Result, "result"),
  evalcase: zodToJsonSchema(EvalCase, "evalcase"),
};

mkdirSync(here, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const outPath = join(here, `${name}.schema.json`);
  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf-8");
  console.log(`wrote ${outPath}`);
}
