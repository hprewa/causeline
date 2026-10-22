import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { readState, updateState } from "./state.js";

/** The limit the person chose for one question, in GB (0 = they chose no limit), or undefined when they have not chosen. */
export function costCap(workspace: string): number | undefined {
  return readState(workspace)?.cost_cap_gb;
}

/**
 * Keep the limit a person chose: in the build record (so a later save keeps it) and, when the pack is already saved, in its data
 * definition (so the next question obeys it). Only for a database that is metered.
 */
export function setCostCap(workspace: string, gb: number): { saved_in_pack: boolean } {
  const state = readState(workspace);
  if (!state) throw new Error("connect the data first; the limit belongs to the BigQuery connection");
  if (state.dialect !== "bigquery") throw new Error("a limit on what a question reads applies to a cloud database; this project reads files on this computer, which cost nothing to read");
  if (!(gb >= 0) || !Number.isFinite(gb)) throw new Error("the limit must be a number of GB, or 0 for no limit");
  updateState(workspace, (s) => {
    s.cost_cap_gb = gb;
  });
  const file = join(workspace, "data.yaml");
  if (!existsSync(file)) return { saved_in_pack: false };
  const doc = parseDocument(readFileSync(file, "utf-8"));
  doc.set("budget_gb", gb);
  writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf-8");
  return { saved_in_pack: true };
}
