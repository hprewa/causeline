import { createHash } from "node:crypto";
import { BigQuery } from "@google-cloud/bigquery";
import type { BigQueryTarget } from "./dryrun.js";

export interface TableToLoad {
  /** Local CSV file with a header row. */
  file: string;
  /** Columns as `name:TYPE,name:TYPE`, in file order. */
  schema: string;
}

const fields = (schema: string) =>
  schema.split(",").map((c) => {
    const [name, type] = c.split(":");
    return { name: name.trim(), type: type.trim().toUpperCase() };
  });

/** A short label value for "this dataset was loaded from this setup", so a later run can reuse it. */
export const setupLabel = (setup: string) => createHash("sha1").update(setup).digest("hex").slice(0, 12);

/**
 * Create the dataset if needed and (re)load its tables from CSV files. Skips the work when the dataset already
 * carries the same setup label and `reuse` is set. Returns whether data was loaded.
 */
export async function loadDataset(target: BigQueryTarget, dataset: string, tables: Record<string, TableToLoad>, opts: { setup: string; reuse?: boolean }): Promise<{ loaded: boolean }> {
  const bq = new BigQuery({ projectId: target.project, location: target.location ?? "US" });
  const label = setupLabel(opts.setup);
  const ds = bq.dataset(dataset);
  const [exists] = await ds.exists();
  if (exists && opts.reuse) {
    const [meta] = await ds.getMetadata();
    if (meta.labels?.setup === label) return { loaded: false };
  }
  if (!exists) await bq.createDataset(dataset, { location: target.location ?? "US" });
  for (const [name, t] of Object.entries(tables)) {
    await ds.table(name).load(t.file, { sourceFormat: "CSV", skipLeadingRows: 1, writeDisposition: "WRITE_TRUNCATE", schema: { fields: fields(t.schema) } });
  }
  await ds.setMetadata({ labels: { setup: label, owner: "causeline-eval" } });
  return { loaded: true };
}
