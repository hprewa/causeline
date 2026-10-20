import { openData, type BuilderData, type ColumnInfo } from "./data.js";
import { assertReadOnlySelect } from "./sqlguard.js";

export interface FactTest {
  ok: boolean;
  /** Plain words when it did not run. */
  error?: string;
  columns: string[];
  /** The database's type of each column, where it says (BigQuery). */
  types?: Record<string, string>;
  /** How many rows the statement returns. */
  rows: number;
  sample: Record<string, unknown>[];
  /** Things worth a look: a column that is always empty, a time column that is not a date. */
  warnings: string[];
  /** What this test read, on a database that meters it (a repeated statement can be answered from a cache and read nothing). */
  bytes?: number;
  /** What one pass over this statement reads, from the free dry run: the same whether or not a cache answered. */
  scan_bytes?: number;
}

const ROWS = "__causeline_rows";

/**
 * Run a draft fact SELECT against the connected data and say what it produces. Read-only (see
 * `assertReadOnlySelect`; on BigQuery the database's own dry run must also call it a SELECT), results capped.
 * Never throws: a statement that does not run is a normal answer. Pass `data` to share one connection (and one
 * budget) across several tests; otherwise the workspace's own is opened and closed.
 */
export async function testFact(opts: { workspace: string; sql: string; limit?: number; time?: string; concepts?: string[]; data?: BuilderData }): Promise<FactTest> {
  const own = !opts.data;
  let data: BuilderData | undefined;
  try {
    data = opts.data ?? (await openData(opts.workspace));
    const sql = assertReadOnlySelect(opts.sql, data.dialect);
    const checked = await data.check(sql);
    if (!checked.ok) return { ok: false, error: checked.error ?? "the statement does not run", columns: [], rows: 0, sample: [], warnings: [] };
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
    // one pass: the sample rows and the row count together (a metered database bills each pass)
    const res = await data.query(`SELECT x.*, COUNT(*) OVER () AS ${ROWS} FROM (${sql}) x LIMIT ${limit}`);
    const rows = res.rows.length === 0 ? 0 : Number(res.rows[0][ROWS]);
    const sample = res.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== ROWS)));
    const types = typeMap(checked.columns);
    const columns = checked.columns.length > 0 ? checked.columns.map((c) => c.name) : sample[0] ? Object.keys(sample[0]) : res.columns.filter((c) => c !== ROWS);
    const warnings: string[] = [];
    if (rows === 0) warnings.push("the statement returns no rows (is a join dropping everything?)");
    for (const c of [opts.time, ...(opts.concepts ?? [])].filter((x): x is string => !!x)) if (columns.length > 0 && !columns.includes(c)) warnings.push(`there is no column called ${c} in the result`);
    if (opts.time && columns.includes(opts.time)) {
      const type = types?.[opts.time];
      if (type !== undefined && type !== "") {
        // the generated queries bucket the time column as a timestamp
        if (type !== "TIMESTAMP") warnings.push(`the time column ${opts.time} is a ${type}; on BigQuery it must be a TIMESTAMP${type === "DATE" || type === "DATETIME" ? `: write TIMESTAMP(${opts.time}) in the SELECT` : ""}`);
      } else if (sample[0] && !/^\d{4}-\d{2}-\d{2}/.test(String(sample[0][opts.time] ?? ""))) warnings.push(`${opts.time} does not look like a date (${String(sample[0][opts.time])})`);
    }
    return { ok: true, columns, ...(types ? { types } : {}), rows, sample, warnings, ...(res.bytes !== undefined ? { bytes: res.bytes } : {}), ...(checked.bytes !== undefined ? { scan_bytes: checked.bytes } : {}) };
  } catch (e) {
    return { ok: false, error: (e as Error).message, columns: [], rows: 0, sample: [], warnings: [] };
  } finally {
    if (own) await data?.close();
  }
}

function typeMap(columns: ColumnInfo[]): Record<string, string> | undefined {
  const typed = columns.filter((c) => c.type !== "");
  return typed.length === 0 ? undefined : Object.fromEntries(typed.map((c) => [c.name, c.type]));
}

/** Do formula expressions run over a fact's columns? Returns the totals they produce, or the reason they do not. One pass over the fact. */
export async function testFormula(opts: { workspace: string; factSql: string; expressions: string[]; data?: BuilderData }): Promise<{ ok: boolean; error?: string; totals?: number[] }> {
  const own = !opts.data;
  let data: BuilderData | undefined;
  try {
    data = opts.data ?? (await openData(opts.workspace));
    const sql = assertReadOnlySelect(opts.factSql, data.dialect);
    for (const e of opts.expressions) assertReadOnlySelect(`SELECT ${e} FROM x`, data.dialect);
    const res = await data.query(`SELECT ${opts.expressions.map((e, i) => `SUM(${e}) AS v${i}`).join(", ")} FROM (${sql}) x`);
    const row = res.rows[0] ?? {};
    return { ok: true, totals: opts.expressions.map((_, i) => Number(row[`v${i}`])) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    if (own) await data?.close();
  }
}
