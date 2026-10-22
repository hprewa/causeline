import { BigQuery } from "@google-cloud/bigquery";
import { classifyBigQueryError, explainBigQueryError, type AccessProblem } from "./explain.js";
import { accessAdvice } from "./access.js";
import type { BigQueryTarget } from "./dryrun.js";

export interface ConnectionCheck {
  ok: boolean;
  steps: { what: string; ok: boolean; detail: string }[];
  /** One plain sentence: what is wrong and what to do, or that all is well. */
  summary: string;
  /** When it failed: which kind of problem, and what to do about it. */
  problem?: AccessProblem;
  advice?: string;
}

/**
 * Can this computer read the project (and, when given, the dataset)? Stops at the first thing that fails. The dataset may be written
 * `project.dataset` when the data lives in a different project from the one that is billed (a public dataset, a colleague's project).
 */
export async function checkConnection(target: BigQueryTarget, dataset?: string): Promise<ConnectionCheck> {
  const steps: ConnectionCheck["steps"] = [];
  const fail = (what: string, e: unknown): ConnectionCheck => {
    const detail = explainBigQueryError(e);
    steps.push({ what, ok: false, detail });
    const problem = classifyBigQueryError(e);
    return { ok: false, steps, summary: detail, problem, advice: accessAdvice(problem) };
  };
  const bq = new BigQuery({ projectId: target.project, location: target.location ?? "US" });
  try {
    await bq.createQueryJob({ query: "SELECT 1", dryRun: true });
    steps.push({ what: "sign-in and project", ok: true, detail: `Signed in, and the project ${target.project} accepts queries.` });
  } catch (e) {
    return fail("sign-in and project", e);
  }
  if (dataset) {
    try {
      const parts = dataset.split(".");
      const [exists] = await (parts.length === 2 ? bq.dataset(parts[1], { projectId: parts[0] }) : bq.dataset(dataset)).exists();
      if (!exists) return fail("dataset", new Error(`Not found: Dataset ${dataset.split(".").pop()}`));
      steps.push({ what: "dataset", ok: true, detail: `The dataset ${dataset} exists and can be read.` });
    } catch (e) {
      return fail("dataset", e);
    }
  }
  return { ok: true, steps, summary: "Connected." };
}
