import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DataDefs } from "../src/data.js";
import { Ontology } from "../src/ontology.js";
import { validatePack } from "../src/validate-pack.js";

const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."), "packs", "_template");

test("the starter pack for a new use case is itself a valid pack", () => {
  const ontology = Ontology.parse(parse(readFileSync(join(dir, "ontology.yaml"), "utf-8")));
  const data = DataDefs.parse(parse(readFileSync(join(dir, "data.yaml"), "utf-8")));
  const issues = validatePack({ ontology, data, agents: [] });
  assert.deepEqual(issues.errors, []);
});
