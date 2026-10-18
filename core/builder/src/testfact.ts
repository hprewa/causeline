import { join } from "node:path";
import { openDb, rowsOf } from "./db.js";
import { assertReadOnlySelect } from "./sqlguard.js";

export interface FactTest {
  ok: boolean;
  /** Plain words when it did not run. */
  error?: string;
  columns: string[];
  /** How many rows the statement returns. */
  rows: number;
  sample: Record<string, unknown>[];
  /** Things worth a look: a column that is always empty, a time column that is not a date. */
  warnings: string[];
}

/**
 * Run a draft fact SELECT against the connected data and say what it produces. Read-only (see
 * `assertReadOnlySelect`), results capped. Never throws: a statement that does not run is a normal answer.
 */
export async function testFact(opts: { workspace: string; sql: string; limit?: number; time?: string; concepts?: string[] }): Promise<FactTest> {
  let sql: string;
  try {
    sql = assertReadOnlySelect(opts.sql);
  } catch (e) {
    return { ok: false, error: (e as Error).message, columns: [], rows: 0, sample: [], warnings: [] };
  }
  const db = await openDb(join(opts.workspace, "data", "causeline.db"));
  try {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
    const sample = rowsOf(db, `SELECT * FROM (${sql}) LIMIT ${limit}`);
    const rows = Number(Object.values(rowsOf(db, `SELECT COUNT(*) AS n FROM (${sql})`)[0])[0]);
    const columns = sample[0] ? Object.keys(sample[0]) : (db.exec(`SELECT * FROM (${sql}) LIMIT 0`)[0]?.columns ?? []);
    const warnings: string[] = [];
    if (rows === 0) warnings.push("the statement returns no rows (is a join dropping everything?)");
    for (const c of [opts.time, ...(opts.concepts ?? [])].filter((x): x is string => !!x)) if (columns.length > 0 && !columns.includes(c)) warnings.push(`there is no column called ${c} in the result`);
    if (opts.time && columns.includes(opts.time) && sample[0] && !/^\d{4}-\d{2}-\d{2}/.test(String(sample[0][opts.time] ?? ""))) warnings.push(`${opts.time} does not look like a date (${String(sample[0][opts.time])})`);
    return { ok: true, columns, rows, sample, warnings };
  } catch (e) {
    return { ok: false, error: (e as Error).message, columns: [], rows: 0, sample: [], warnings: [] };
  } finally {
    db.close();
  }
}

/** Does a formula expression run over a fact's columns? Returns the totals it produces, or the reason it does not. */
export async function testFormula(opts: { workspace: string; factSql: string; expressions: string[] }): Promise<{ ok: boolean; error?: string; totals?: number[] }> {
  try {
    const sql = assertReadOnlySelect(opts.factSql);
    for (const e of opts.expressions) assertReadOnlySelect(`SELECT ${e} FROM x`);
    const db = await openDb(join(opts.workspace, "data", "causeline.db"));
    try {
      const row = rowsOf(db, `SELECT ${opts.expressions.map((e, i) => `SUM(${e}) AS v${i}`).join(", ")} FROM (${sql})`)[0];
      return { ok: true, totals: opts.expressions.map((_, i) => Number(row[`v${i}`])) };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
