import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack } from "@causeline/schema";
import { checkGenerated, generateForPack } from "../src/pack.js";

const ONTOLOGY = `
time: { levels: [week, day], seasonality: none }
hierarchies: { h1: [a1, a2] }
dimensions: [d1]
metrics:
  m: { type: ratio, direction: higher_is_better, min_volume: 10 }
`;

const DATA = `
source: my-db
facts:
  events:
    sql: SELECT ts, a1, a2, d1, ok FROM facts
    time: ts
    concepts: [a1, a2, d1]
metrics:
  m: { fact: events, numerator: ok }
`;

function makePack(): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  mkdirSync(join(dir, "toolbox"));
  writeFileSync(join(dir, "ontology.yaml"), ONTOLOGY);
  writeFileSync(join(dir, "data.yaml"), DATA);
  return dir;
}

test("loadPack names the file and the field when a definition is wrong", () => {
  const pack = makePack();
  writeFileSync(join(pack, "data.yaml"), DATA.replace("time: ts", "time: 'not an identifier'"));
  assert.throws(() => loadPack(pack), /data\.yaml is not valid:[\s\S]*facts\.events\.time/);
  assert.throws(() => loadPack(join(pack, "nowhere")), /does not exist/);
});

test("the source name comes from data.yaml; generateForPack writes the tools and the sidecar index", () => {
  const pack = makePack();
  assert.equal(checkGenerated(pack), "missing");

  const { path, metaPath, generated } = generateForPack(pack);
  assert.ok(generated.tools.length > 10);
  assert.match(readFileSync(path, "utf-8"), /source: my-db/);
  assert.ok(existsSync(metaPath));
  assert.equal(metaPath, join(pack, "tools.meta.yaml"), "the index sits at the pack root, outside Toolbox's config folder");
  assert.equal(loadPack(pack, { requireMeta: true }).meta!.tools.m_by_a1.kind, "slice");
  assert.equal(checkGenerated(pack), "fresh");

  writeFileSync(path, readFileSync(path, "utf-8") + "# hand edit\n");
  assert.equal(checkGenerated(pack), "stale");

  generateForPack(pack);
  assert.equal(checkGenerated(pack), "fresh");

  // changing either definition file makes the generated files stale until regenerated
  writeFileSync(join(pack, "ontology.yaml"), ONTOLOGY.replace("dimensions: [d1]", "dimensions: [d1, d2]"));
  assert.equal(checkGenerated(pack), "stale");
  generateForPack(pack, {});
});
