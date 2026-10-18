// Shared by packs that make their eval data with a Python generator and a DuckDB loader.
// Not part of the core: the core's eval runner only knows the contract in
// core/eval/src/prepare.ts (a pack's evals/prepare.mjs leaves a complete pack in workDir).
//
// A pack using this follows one convention:
//   data/generate.py   accepts the case's setup string (for example --fault ...) and --out-dir
//   data/load.sql      reads raw/*.csv and writes causeline.db, with paths relative to the data directory
//   data/indexes.sql   optional: indexes applied to causeline.db afterwards, so joins in data.yaml stay quick
//   ontology.yaml, data.yaml, tools.meta.yaml, toolbox/, and optionally playbooks/   copied into the case's pack as they are
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Run a command to completion; reject with its output if it fails. */
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.once("error", (e) => reject(new Error(`could not run ${command}: ${e.message}`)));
    child.once("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}:\n${output.slice(-1500)}`))));
  });
}

/** Split "--fault a:b --fault c:d" into arguments (these strings never need quoting). */
const splitArgs = (s) => s.split(/\s+/).filter(Boolean);

function findOnPath(names) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const p = join(dir, name);
      if (dir && existsSync(p)) return p;
    }
  }
  return undefined;
}

function duckdb() {
  const winget = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages", "DuckDB.cli_Microsoft.Winget.Source_8wekyb3d8bbwe", "duckdb.exe");
  const found = process.env.CAUSELINE_DUCKDB || findOnPath(["duckdb", "duckdb.exe"]) || (winget && existsSync(winget) ? winget : undefined);
  if (!found) throw new Error("DuckDB CLI not found; install it (winget install DuckDB.cli) or set CAUSELINE_DUCKDB");
  return found;
}

const python = () => process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");

/** Build a self-contained pack for one eval case. See the convention at the top of this file. */
export async function prepareSynthetic({ setup, workDir, packDir, reuse }) {
  const marker = join(workDir, ".setup");
  if (reuse && existsSync(marker) && readFileSync(marker, "utf-8") === setup && existsSync(join(workDir, "data", "causeline.db"))) return;

  rmSync(workDir, { recursive: true, force: true });
  const data = join(workDir, "data");
  mkdirSync(data, { recursive: true });

  // 1. synthetic data with the case's faults
  await run(python(), [join(packDir, "data", "generate.py"), ...splitArgs(setup), "--out-dir", join(data, "raw")], packDir);

  // 2. load it into SQLite
  await run(duckdb(), ["-c", readFileSync(join(packDir, "data", "load.sql"), "utf-8")], data);
  if (!existsSync(join(data, "causeline.db"))) throw new Error("the DuckDB loader did not produce data/causeline.db");

  // 2b. keys, if the pack has them (data/indexes.sql): the joins in data.yaml need them to be quick
  const indexes = join(packDir, "data", "indexes.sql");
  if (existsSync(indexes)) {
    const script = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(open(sys.argv[2],encoding='utf-8').read()); c.commit()";
    await run(python(), ["-I", "-c", script, join(data, "causeline.db"), indexes], packDir);
  }

  // 3. the rest of the pack (database paths in toolbox/ are relative to the pack)
  for (const file of ["ontology.yaml", "data.yaml", "tools.meta.yaml"]) cpSync(join(packDir, file), join(workDir, file));
  cpSync(join(packDir, "toolbox"), join(workDir, "toolbox"), { recursive: true });
  if (existsSync(join(packDir, "playbooks"))) cpSync(join(packDir, "playbooks"), join(workDir, "playbooks"), { recursive: true });
  if (existsSync(join(packDir, "agents"))) cpSync(join(packDir, "agents"), join(workDir, "agents"), { recursive: true });

  writeFileSync(marker, setup, "utf-8");
}
