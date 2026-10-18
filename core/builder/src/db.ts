import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// sql.js is SQLite compiled to WebAssembly: no native build, no database server, nothing for a user to install.
const require = createRequire(import.meta.url);
type SqlJs = { Database: new (data?: Uint8Array) => SqlDb };
export interface SqlDb {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): { run(params?: unknown[]): void; free(): void };
  export(): Uint8Array;
  close(): void;
}

let loaded: Promise<SqlJs> | undefined;
async function sql(): Promise<SqlJs> {
  loaded ??= (require("sql.js") as (cfg?: object) => Promise<SqlJs>)();
  return loaded;
}

export async function newDb(): Promise<SqlDb> {
  return new (await sql()).Database();
}

/** Open a database file in memory. Nothing done to it is written back unless `saveDb` is called. */
export async function openDb(path: string): Promise<SqlDb> {
  if (!existsSync(path)) throw new Error(`${path} does not exist; connect the files first`);
  return new (await sql()).Database(new Uint8Array(readFileSync(path)));
}

export function saveDb(db: SqlDb, path: string): void {
  writeFileSync(path, Buffer.from(db.export()));
}

/** Rows of one query as objects. */
export function rowsOf(db: SqlDb, query: string, params: unknown[] = []): Record<string, unknown>[] {
  const res = db.exec(query, params)[0];
  if (!res) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

export const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
