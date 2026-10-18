import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { inferColumn, parseCsv, slug } from "./csv.js";
import { newDb, openDb, q, saveDb } from "./db.js";
import { newState, readState, writeState } from "./state.js";

export interface ConnectedTable {
  table: string;
  file: string;
  rows: number;
  columns: { name: string; was?: string; type: string; note?: string }[];
}

export interface ConnectResult {
  workspace: string;
  source: string;
  tables: ConnectedTable[];
  /** Things a person should look at: renamed columns, unreadable dates, repeated header names. */
  notes: string[];
}

/**
 * Load the user's CSV files into one SQLite file in the workspace, one table per file. Types come from the
 * data (all of it), dates are stored as ISO text, names become plain identifiers. Everything stays on this
 * machine. Calling it again with more files adds them (a file with the same table name replaces its table).
 */
export async function connectFiles(opts: { workspace: string; files: string[] }): Promise<ConnectResult> {
  const workspace = resolve(opts.workspace);
  if (opts.files.length === 0) throw new Error("no files given");
  mkdirSync(join(workspace, "data", "raw"), { recursive: true });
  mkdirSync(join(workspace, "toolbox"), { recursive: true });
  const dbPath = join(workspace, "data", "causeline.db");
  const db = existsSync(dbPath) ? await openDb(dbPath) : await newDb();
  const source = `${slug(basename(workspace))}-db`.replace(/_/g, "-");
  const tables: ConnectedTable[] = [];
  const notes: string[] = [];

  for (const file of opts.files) {
    const path = resolve(file);
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    if (extname(path).toLowerCase() !== ".csv") throw new Error(`${basename(path)} is not a CSV file; only CSV is supported so far (export the sheet as CSV)`);
    const { header, rows } = parseCsv(readFileSync(path, "utf-8"));
    if (header.length === 0 || rows.length === 0) throw new Error(`${basename(path)} has no data rows`);
    const table = slug(basename(path, extname(path)));

    // column names: plain identifiers, made unique
    const seen = new Set<string>();
    const names = header.map((h, i) => {
      let n = slug(h || `column_${i + 1}`);
      while (seen.has(n)) n += "_2";
      seen.add(n);
      return n;
    });
    const columns = names.map((name, c) => {
      const inferred = inferColumn(rows.map((r) => r[c] ?? ""));
      return { name, was: header[c] !== name ? header[c] : undefined, inferred };
    });

    db.run(`DROP TABLE IF EXISTS ${q(table)}`);
    const sqlType = (t: string) => (t === "integer" ? "INTEGER" : t === "real" ? "REAL" : "TEXT");
    db.run(`CREATE TABLE ${q(table)} (${columns.map((c) => `${q(c.name)} ${sqlType(c.inferred.type)}`).join(", ")})`);
    const insert = db.prepare(`INSERT INTO ${q(table)} VALUES (${columns.map(() => "?").join(",")})`);
    db.run("BEGIN");
    for (const r of rows) insert.run(columns.map((c, i) => c.inferred.convert(r[i] ?? "")));
    db.run("COMMIT");
    insert.free();

    copyFileSync(path, join(workspace, "data", "raw", basename(path)));
    const connected: ConnectedTable = { table, file: basename(path), rows: rows.length, columns: columns.map((c) => ({ name: c.name, was: c.was, type: c.inferred.type, note: c.inferred.note })) };
    tables.push(connected);
    for (const c of connected.columns) {
      if (c.was) notes.push(`${table}: column "${c.was}" is called ${c.name} here`);
      if (c.note) notes.push(`${table}.${c.name}: ${c.note}`);
    }
    if (names.length !== new Set(header).size) notes.push(`${table}: some column headings repeated or were empty and were renamed`);
  }
  saveDb(db, dbPath);
  db.close();

  writeFileSync(join(workspace, "toolbox", "source.yaml"), `kind: source\nname: ${source}\ntype: sqlite\ndatabase: "data/causeline.db"\n`, "utf-8");
  const state = readState(workspace) ?? newState(source);
  for (const t of tables) {
    state.tables = state.tables.filter((x) => x.name !== t.table);
    state.tables.push({ name: t.table, file: t.file, rows: t.rows, columns: t.columns.length, notes: notes.filter((n) => n.startsWith(`${t.table}`)) });
  }
  state.profiled = false;
  writeState(workspace, state);
  return { workspace, source: state.source, tables, notes };
}
