// Shared by packs that make their eval data with a Python generator and want it in BigQuery. The BigQuery
// counterpart of synthetic-prepare.mjs; a pack's evals/prepare.mjs picks one by CAUSELINE_TARGET.
//
// A pack using this follows one convention:
//   data/generate.py          accepts the case's setup string (for example --fault ...) and --out-dir
//   data/bigquery.json        { "tables": { "<table>": { "file": "<csv in out-dir>", "schema": "col:TYPE,col:TYPE" } } }
//   data.bigquery.yaml        the pack's data definition in BigQuery SQL, with `__DATASET__` for "<project>.<dataset>"
//   toolbox.bigquery/         the Toolbox source (the project comes from CAUSELINE_BQ_PROJECT)
//   ontology.yaml, and optionally agents/ and playbooks/   copied into the case's pack as they are
//
// Each case gets its own dataset: <CAUSELINE_BQ_DATASET_PREFIX or "causeline_eval">_<case id>. Needs Application
// Default Credentials and CAUSELINE_BQ_PROJECT.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadDataset } from "../../core/connect-bigquery/dist/src/index.js";
import { generateForPack } from "../../core/generate/dist/src/index.js";

function run(command, args, cwd) {
  return new Promise((res, rej) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.once("error", (e) => rej(new Error(`could not run ${command}: ${e.message}`)));
    child.once("close", (code) => (code === 0 ? res(output) : rej(new Error(`${command} exited ${code}:\n${output.slice(-1500)}`))));
  });
}

const python = () => process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");
const splitArgs = (s) => s.split(/\s+/).filter(Boolean);

/** Build a self-contained BigQuery-backed pack for one eval case. */
export async function prepareSyntheticBigQuery({ setup, workDir, packDir, reuse }) {
  const project = process.env.CAUSELINE_BQ_PROJECT;
  if (!project) throw new Error("set CAUSELINE_BQ_PROJECT to the Google Cloud project the evals should use");
  const prefix = process.env.CAUSELINE_BQ_DATASET_PREFIX || "causeline_eval";
  const dataset = `${prefix}_${basename(workDir)}`.replace(/[^A-Za-z0-9_]/g, "_");

  const marker = join(workDir, ".setup");
  const stamp = `${setup}|${dataset}`;
  if (reuse && existsSync(marker) && readFileSync(marker, "utf-8") === stamp && existsSync(join(workDir, "toolbox", "tools.generated.yaml"))) return;

  rmSync(workDir, { recursive: true, force: true });
  const raw = join(workDir, "data", "raw");
  mkdirSync(raw, { recursive: true });

  // 1. synthetic data with the case's faults, then into this case's dataset
  await run(python(), [join(packDir, "data", "generate.py"), ...splitArgs(setup), "--out-dir", raw], packDir);
  const spec = JSON.parse(readFileSync(join(packDir, "data", "bigquery.json"), "utf-8"));
  const tables = Object.fromEntries(Object.entries(spec.tables).map(([name, t]) => [name, { file: join(raw, t.file), schema: t.schema }]));
  await loadDataset({ project }, dataset, tables, { setup, reuse });

  // 2. the rest of the pack, with the dataset filled in, and its tools generated for it
  cpSync(join(packDir, "ontology.yaml"), join(workDir, "ontology.yaml"));
  writeFileSync(join(workDir, "data.yaml"), readFileSync(join(packDir, "data.bigquery.yaml"), "utf-8").replaceAll("__DATASET__", `${project}.${dataset}`), "utf-8");
  cpSync(join(packDir, "toolbox.bigquery"), join(workDir, "toolbox"), { recursive: true });
  generateForPack(resolve(workDir));
  if (existsSync(join(packDir, "playbooks"))) cpSync(join(packDir, "playbooks"), join(workDir, "playbooks"), { recursive: true });
  if (existsSync(join(packDir, "agents"))) cpSync(join(packDir, "agents"), join(workDir, "agents"), { recursive: true });

  writeFileSync(marker, stamp, "utf-8");
}
