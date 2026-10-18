import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { EvalCases, type EvalCase } from "@causeline/schema";

/** Load a pack's eval cases (<pack>/evals/cases.yaml), optionally narrowed to some ids. */
export function loadCases(packDir: string, only?: string[]): EvalCase[] {
  const all = EvalCases.parse(parse(readFileSync(join(packDir, "evals", "cases.yaml"), "utf-8")));
  const ids = new Set(all.map((c) => c.id));
  if (ids.size !== all.length) throw new Error("eval case ids must be unique");
  if (!only?.length) return all;
  const missing = only.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`no such eval case: ${missing.join(", ")} (have: ${[...ids].join(", ")})`);
  return all.filter((c) => only.includes(c.id));
}
