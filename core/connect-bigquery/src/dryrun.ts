import { BigQuery } from "@google-cloud/bigquery";

export interface BigQueryTarget {
  project: string;
  location?: string;
}

/** What a statement would cost to run, from BigQuery's own dry run: nothing is read and nothing is billed. */
export async function dryRun(target: BigQueryTarget, sql: string, params: Record<string, string> = {}): Promise<{ bytes: number }> {
  const bq = new BigQuery({ projectId: target.project, location: target.location ?? "US" });
  const [job] = await bq.createQueryJob({ query: sql, params, parameterMode: "named", dryRun: true });
  return { bytes: Number(job.metadata?.statistics?.totalBytesProcessed ?? 0) };
}
