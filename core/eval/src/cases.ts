import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { EvalCases, type EvalCase } from "@causeline/schema";

/** Load a pack's eval cases (<pack>/evals/cases.yaml, or another file of cases in that folder), optionally narrowed to some ids. */
export function loadCases(packDir: string, only?: string[], file = "cases"): EvalCase[] {
  if (!/^[A-Za-z0-9_-]+$/.test(file)) throw new Error(`"${file}" is not the name of a file of cases`);
  const all = EvalCases.parse(parse(readFileSync(join(packDir, "evals", `${file}.yaml`), "utf-8")));
  const ids = new Set(all.map((c) => c.id));
  if (ids.size !== all.length) throw new Error("eval case ids must be unique");
  if (!only?.length) return all;
  const missing = only.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`no such eval case: ${missing.join(", ")} (have: ${[...ids].join(", ")})`);
  return all.filter((c) => only.includes(c.id));
}
