import { BigQuery } from "@google-cloud/bigquery";
import { BudgetError, registerData, type BuilderData, type BuildState, type ColumnInfo, type DataTable, type QueryResult, type StatementCheck } from "@causeline/builder";
import type { BigQueryTarget } from "./dryrun.js";
import { explainBigQueryError } from "./explain.js";

/** On-demand list price per tebibyte read; the first terabyte each month is free, so this is an upper estimate. */
const USD_PER_TIB = 6.25;
export const BUILDER_BUDGET_GB = 5;

export interface TableRef {
  project: string;
  dataset: string;
  table: string;
}

/** What the Builder needs from BigQuery, small enough to stand in for in tests. */
export interface BigQueryApi {
  /** A free dry run: the statement type, the columns it returns, and what it would read. */
  dryRun(sql: string): Promise<{ statementType: string; columns: ColumnInfo[]; bytes: number }>;
  run(sql: string, opts: { maximumBytes?: number }): Promise<{ rows: Record<string, unknown>[]; bytes: number }>;
  table(ref: TableRef): Promise<DataTable>;
  tables(ref: { project: string; dataset: string }): Promise<TableRef[]>;
}

const gb = (b: number) => (b / 1e9).toFixed(b >= 1e10 ? 0 : 1);

/** A value as plain data: timestamps and dates as text, big numbers as numbers, lists and records as they are. */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (Buffer.isBuffer(v)) return "[bytes]";
  const o = v as { value?: unknown; constructor?: { name?: string }; toString(): string };
  if (o.constructor?.name === "Big") return Number(o.toString());
  if ("value" in o && Object.keys(o).length === 1) return plain(o.value);
  return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)]));
}

/** The real thing: Application Default Credentials (`gcloud auth application-default login`), queries billed to `target.project`. */
export function googleApi(target: BigQueryTarget): BigQueryApi {
  const bq = new BigQuery({ projectId: target.project, location: target.location ?? "US" });
  const columnsOf = (fields: { name: string; type: string; mode?: string }[] = []): ColumnInfo[] => fields.map((f) => ({ name: f.name, type: f.type.toUpperCase(), ...(f.mode === "REPEATED" ? { repeated: true } : {}) }));
  return {
    async dryRun(sql) {
      const [job] = await bq.createQueryJob({ query: sql, dryRun: true });
      const q = job.metadata?.statistics?.query ?? {};
      return { statementType: String(q.statementType ?? ""), columns: columnsOf(q.schema?.fields), bytes: Number(job.metadata?.statistics?.totalBytesProcessed ?? 0) };
    },
    async run(sql, opts) {
      const [job] = await bq.createQueryJob({ query: sql, ...(opts.maximumBytes ? { maximumBytesBilled: String(Math.ceil(opts.maximumBytes)) } : {}) });
      const [rows] = await job.getQueryResults({ maxResults: 10000 });
      const [meta] = await job.getMetadata();
      return { rows: rows as Record<string, unknown>[], bytes: Number(meta.statistics?.totalBytesProcessed ?? 0) };
    },
    async table(ref) {
      const [meta] = await bq.dataset(ref.dataset, { projectId: ref.project }).table(ref.table).getMetadata();
      return {
        name: `${ref.project}.${ref.dataset}.${ref.table}`,
        rows: meta.numRows === undefined ? undefined : Number(meta.numRows),
        bytes: meta.numBytes === undefined ? undefined : Number(meta.numBytes),
        columns: columnsOf(meta.schema?.fields),
        kind: meta.type === "VIEW" ? "view" : "table",
      };
    },
    async tables(ref) {
      const [list] = await bq.dataset(ref.dataset, { projectId: ref.project }).getTables({ maxResults: 100 });
      return list.map((t) => ({ project: ref.project, dataset: ref.dataset, table: String(t.id) }));
    },
  };
}

/**
 * The Builder's view of a BigQuery connection. Every statement is dry-run first, free: it must be a SELECT to BigQuery's
 * own mind (the textual guard is the first check, this is the one that decides), and it is refused, before it is sent, when
 * it would take what one Builder step has read past the budget. What each step read is reported with its result.
 */
export class BigQueryData implements BuilderData {
  readonly dialect = "bigquery" as const;
  private queries = 0;
  private bytes = 0;

  constructor(
    private readonly api: BigQueryApi,
    private readonly opts: { tables: TableRef[]; budgetBytes: number | null },
  ) {}

  ref = (table: string) => `\`${table.replace(/`/g, "")}\``;
  quote = (name: string) => `\`${name.replace(/`/g, "")}\``;

  async tables(): Promise<DataTable[]> {
    return Promise.all(this.opts.tables.map((t) => this.api.table(t)));
  }

  async check(sql: string): Promise<StatementCheck> {
    try {
      const d = await this.api.dryRun(sql);
      if (d.statementType !== "SELECT") return { ok: false, error: `BigQuery reads this as a ${d.statementType || "statement that is not a SELECT"}; only reading is allowed`, columns: [] };
      return { ok: true, columns: d.columns, bytes: d.bytes };
    } catch (e) {
      return { ok: false, error: explainBigQueryError(e), columns: [] };
    }
  }

  async query(sql: string): Promise<QueryResult> {
    const c = await this.check(sql);
    if (!c.ok) throw new Error(c.error);
    const b = this.opts.budgetBytes;
    if (b !== null && this.bytes + (c.bytes ?? 0) > b) {
      throw new BudgetError(`This would read ${gb(c.bytes ?? 0)} GB of BigQuery data (${gb(this.bytes)} GB already read in this step), past the limit of ${gb(b)} GB for one step. Narrow it down, or raise the limit (CAUSELINE_BQ_BUDGET_GB) if this is expected.`, c.bytes ?? 0);
    }
    const r = await this.api.run(sql, { maximumBytes: b === null ? undefined : b - this.bytes });
    this.queries++;
    this.bytes += r.bytes;
    return { columns: r.rows[0] ? Object.keys(r.rows[0]) : c.columns.map((x) => x.name), rows: r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)]))), bytes: r.bytes };
  }

  usage() {
    return { queries: this.queries, bytes: this.bytes, estimated_usd: Math.round((this.bytes / 2 ** 40) * USD_PER_TIB * 1e6) / 1e6 };
  }

  close(): void {}
}

/** `project.dataset.table`, or `dataset.table` (the billing project holds it). */
export function parseTableRef(text: string, project: string): TableRef {
  const parts = text.replace(/`/g, "").trim().split(".");
  if (parts.length === 3) return { project: parts[0], dataset: parts[1], table: parts[2] };
  if (parts.length === 2) return { project, dataset: parts[0], table: parts[1] };
  throw new Error(`"${text}" is not a table name; write it as project.dataset.table (or dataset.table)`);
}

export function budgetBytes(env: NodeJS.ProcessEnv = process.env): number | null {
  const gbs = Number(env.CAUSELINE_BQ_BUDGET_GB ?? BUILDER_BUDGET_GB);
  return gbs > 0 ? gbs * 1e9 : null;
}

/** Make BigQuery available to the Builder for workspaces connected with `connect_bigquery`. */
export function registerBigQuery(): void {
  registerData("bigquery", async (_workspace: string, state: BuildState) => {
    const bq = state.bigquery;
    if (!bq) throw new Error("this workspace is not connected to BigQuery yet (connect_bigquery)");
    return new BigQueryData(googleApi({ project: bq.project, location: bq.location }), { tables: state.tables.map((t) => parseTableRef(t.name, bq.project)), budgetBytes: budgetBytes() });
  });
}
