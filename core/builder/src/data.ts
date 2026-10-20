import { join } from "node:path";
import { existsSync } from "node:fs";
import { openDb, q, rowsOf } from "./db.js";
import { readState, type BuildState } from "./state.js";

export type Dialect = "sqlite" | "bigquery";

export interface ColumnInfo {
  name: string;
  /** The database's own type name (INTEGER, STRING, TIMESTAMP, ...), upper case; empty when it does not say. */
  type: string;
  /** An array column: its values are lists. */
  repeated?: boolean;
}

export interface DataTable {
  /** The name to use in SQL (a plain name, or `project.dataset.table` on BigQuery). */
  name: string;
  rows?: number;
  bytes?: number;
  columns: ColumnInfo[];
  /** A view or a partitioned table says so; a sample cannot be taken from a view. */
  kind?: "table" | "view";
  note?: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** What the query read, when the database meters it. */
  bytes?: number;
}

export interface StatementCheck {
  ok: boolean;
  /** Plain words, when it is not ok. */
  error?: string;
  columns: ColumnInfo[];
  /** What running it would read, from a free dry run (BigQuery). */
  bytes?: number;
}

export interface Usage {
  queries: number;
  bytes: number;
  estimated_usd: number;
}

/**
 * Everything the Builder needs from a database, in one small surface, so that profiling, trying a draft and saving a
 * pack are written once and work on a local file or on BigQuery. Only reads: `query` runs one SELECT, and a
 * database that meters its reads (BigQuery) refuses a statement before it would pass the budget.
 */
export interface BuilderData {
  dialect: Dialect;
  /** A table as SQL writes it. */
  ref(table: string): string;
  /** A column or alias as SQL writes it. */
  quote(name: string): string;
  tables(): Promise<DataTable[]>;
  /** Run one read-only SELECT. */
  query(sql: string): Promise<QueryResult>;
  /** Say what a statement is and what it returns, without running it where the database can. */
  check(sql: string): Promise<StatementCheck>;
  usage(): Usage | undefined;
  close(): Promise<void> | void;
}

/** A statement that would read more than the budget allows. Nothing was run. */
export class BudgetError extends Error {
  constructor(
    message: string,
    readonly bytes: number,
  ) {
    super(message);
  }
}

type Factory = (workspace: string, state: BuildState) => Promise<BuilderData>;
const factories = new Map<Dialect, Factory>();

/** Make a database kind available to the Builder (the BigQuery package registers itself here). */
export function registerData(dialect: Dialect, factory: Factory): void {
  factories.set(dialect, factory);
}

/** The data the workspace is connected to, as `build.json` says. The caller closes it. */
export async function openData(workspace: string): Promise<BuilderData> {
  const state = readState(workspace);
  const dialect: Dialect = state?.dialect ?? "sqlite";
  const make = factories.get(dialect);
  if (make) return make(workspace, state ?? ({} as BuildState));
  if (dialect === "sqlite") return sqliteData(workspace);
  throw new Error(`this workspace reads ${dialect}, which is not available in this build`);
}

/** The local database in the workspace (the user's CSV files). */
export async function sqliteData(workspace: string): Promise<BuilderData> {
  const file = join(workspace, "data", "causeline.db");
  if (!existsSync(file)) throw new Error(`${file} does not exist; connect the files first`);
  const db = await openDb(file);
  let queries = 0;
  return {
    dialect: "sqlite",
    ref: q,
    quote: q,
    async tables() {
      const names = rowsOf(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));
      return names.map((name) => ({
        name,
        rows: Number(Object.values(rowsOf(db, `SELECT COUNT(*) FROM ${q(name)}`)[0])[0]),
        columns: rowsOf(db, `PRAGMA table_info(${q(name)})`).map((c) => ({ name: String(c.name), type: String(c.type).toUpperCase() })),
        kind: "table" as const,
      }));
    },
    async query(sql) {
      queries++;
      const res = db.exec(sql)[0];
      return { columns: res?.columns ?? [], rows: res ? res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]]))) : [] };
    },
    async check(sql) {
      try {
        const res = db.exec(`SELECT * FROM (${sql}) LIMIT 0`)[0];
        return { ok: true, columns: (res?.columns ?? Object.keys(rowsOf(db, `SELECT * FROM (${sql}) LIMIT 1`)[0] ?? {})).map((name) => ({ name, type: "" })) };
      } catch (e) {
        return { ok: false, error: (e as Error).message, columns: [] };
      }
    },
    usage: () => ({ queries, bytes: 0, estimated_usd: 0 }),
    close: () => db.close(),
  };
}
