#!/usr/bin/env node
// Dry-run every statement a pack's BigQuery target generates. BigQuery checks the SQL (syntax, names, types)
// and reports the bytes it would read; nothing runs and nothing is billed.
//   node scripts/bq-dryrun.mjs <pack dir> --dataset <project.dataset> [--target bigquery]
// Needs Application Default Credentials (`gcloud auth application-default login`) and a dataset holding the pack's tables.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { dryRun } from "../core/connect-bigquery/dist/src/index.js";
import { generateForPack } from "../core/generate/dist/src/index.js";

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const packDir = resolve(args.find((a) => !a.startsWith("--")) ?? "");
const target = flag("target", "bigquery");
const dataset = flag("dataset", process.env.CAUSELINE_BQ_DATASET);
if (!dataset || !dataset.includes(".")) {
  console.error("usage: node scripts/bq-dryrun.mjs <pack dir> --dataset <project.dataset> [--target bigquery]");
  process.exit(2);
}
const project = dataset.split(".")[0];

// a work copy: the target's files under the standard names, with the dataset filled in
const work = mkdtempSync(join(tmpdir(), "bq-dryrun-"));
cpSync(join(packDir, "ontology.yaml"), join(work, "ontology.yaml"));
writeFileSync(join(work, "data.yaml"), readFileSync(join(packDir, `data.${target}.yaml`), "utf-8").replaceAll("__DATASET__", dataset));
mkdirSync(join(work, "toolbox"));
if (existsSync(join(packDir, `toolbox.${target}`, "source.yaml"))) cpSync(join(packDir, `toolbox.${target}`, "source.yaml"), join(work, "toolbox", "source.yaml"));
const gen = generateForPack(work);

const sample = (name) => (/^(cur_|base_)?(start|end)$/.test(name) || name === "w_start" || name === "w_end" ? "2026-02-09 00:00:00" : name === "aggregation" ? "day" : "");
const docs = parseAllDocuments(readFileSync(gen.path, "utf-8")).map((d) => d.toJS()).filter((d) => d.kind === "tool");

let bytes = 0;
const failures = [];
for (const tool of docs) {
  const params = Object.fromEntries((tool.parameters ?? []).map((p) => [p.name, sample(p.name)]));
  try {
    bytes += (await dryRun({ project }, tool.statement, params)).bytes;
  } catch (e) {
    failures.push(`${tool.name}: ${(e.errors?.[0]?.message ?? e.message).split("\n")[0]}`);
  }
}
console.log(`${docs.length} statements, ${docs.length - failures.length} valid, ${bytes} bytes in total for one call of each`);
for (const f of failures) console.log("  FAIL " + f);
process.exit(failures.length === 0 ? 0 : 1);
