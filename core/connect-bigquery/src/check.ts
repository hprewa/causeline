import { BigQuery } from "@google-cloud/bigquery";
import { explainBigQueryError } from "./explain.js";
import type { BigQueryTarget } from "./dryrun.js";

export interface ConnectionCheck {
  ok: boolean;
  steps: { what: string; ok: boolean; detail: string }[];
  /** One plain sentence: what is wrong and what to do, or that all is well. */
  summary: string;
}

/** Can this computer read the project (and, when given, the dataset)? Stops at the first thing that fails. */
export async function checkConnection(target: BigQueryTarget, dataset?: string): Promise<ConnectionCheck> {
  const steps: ConnectionCheck["steps"] = [];
  const fail = (what: string, e: unknown): ConnectionCheck => {
    const detail = explainBigQueryError(e);
    steps.push({ what, ok: false, detail });
    return { ok: false, steps, summary: detail };
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
      const [exists] = await bq.dataset(dataset).exists();
      if (!exists) return fail("dataset", new Error(`Not found: Dataset ${dataset}`));
      steps.push({ what: "dataset", ok: true, detail: `The dataset ${dataset} exists and can be read.` });
    } catch (e) {
      return fail("dataset", e);
    }
  }
  return { ok: true, steps, summary: "Connected." };
}
