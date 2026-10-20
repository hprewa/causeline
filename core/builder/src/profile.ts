import { join } from "node:path";
import { openDb, q, rowsOf, type SqlDb } from "./db.js";
import { openData } from "./data.js";
import { describeRemote } from "./profile-remote.js";
import { readState, updateState } from "./state.js";

export interface ColumnProfile {
  name: string;
  /** What the column is stored as. */
  type: string;
  nulls: number;
  distinct: number;
  samples: (string | number)[];
  min?: string | number;
  max?: string | number;
  /** Suggestions only: `time`, `key` (every value different), `flag` (only 0 and 1), `measure` (a number), `concept` (a few repeating values). */
  roles: string[];
}

export interface TableProfile {
  table: string;
  rows: number;
  columns: ColumnProfile[];
}

export interface JoinCandidate {
  from: string;
  to: string;
  /** `many_to_one`: each row on the `from` side has at most one on the `to` side, so joining does not multiply rows. */
  shape: "many_to_one" | "one_to_one" | "many_to_many";
  /** Share of the `from` table's distinct values found on the `to` side. */
  coverage: number;
  /** Rows of `from` with no match. */
  unmatched_rows: number;
}

export interface HierarchyCandidate {
  table: string;
  /** Coarse to fine: each level belongs to exactly one of the one before. */
  levels: string[];
}

export interface TimeCandidate {
  table: string;
  column: string;
  from: string;
  to: string;
  days: number;
}

export interface DataDescription {
  tables: TableProfile[];
  joins: JoinCandidate[];
  hierarchies: HierarchyCandidate[];
  time: TimeCandidate[];
  /** Questions the data cannot answer on its own. */
  ask: string[];
  /** Things to know that are not questions: columns left out, a sample used, a fixed end date. */
  notes?: string[];
  /** On a metered database: what looking at the data read. */
  cost?: { queries: number; bytes: number; estimated_usd: number };
}

const scalar = (db: SqlDb, query: string) => Number(Object.values(rowsOf(db, query)[0] ?? { n: 0 })[0] ?? 0);

export type Kind = "integer" | "real" | "text" | "date" | "datetime" | "bool";

/**
 * What a column looks like it is, from its statistics: `time` (a date), `key` (every value different), `flag` (only 0 and 1),
 * `measure` (a number) or `concept` (a few repeating values). Suggestions only. `keyTolerance` below 1 lets a key be
 * recognised from an approximate distinct count.
 */
export function columnRoles(kind: Kind, s: { rows: number; nulls: number; distinct: number; lo: unknown; hi: unknown; keyTolerance?: number }): string[] {
  const numeric = kind === "integer" || kind === "real";
  const dateLike = kind === "date" || kind === "datetime";
  const nonNull = s.rows - s.nulls;
  const roles: string[] = [];
  if (dateLike) roles.push("time");
  if (nonNull > 0 && s.distinct >= nonNull * (s.keyTolerance ?? 1) && !dateLike && kind !== "real" && kind !== "bool" && s.rows > 1) roles.push("key");
  if (kind === "bool" || (kind === "integer" && s.distinct <= 2 && Number(s.lo) >= 0 && Number(s.hi) <= 1)) roles.push("flag");
  else if (numeric && !roles.includes("key") && s.distinct > 2) roles.push("measure");
  if (!numeric && !dateLike && kind !== "bool" && !roles.includes("key") && s.distinct >= 2 && s.distinct <= Math.max(50, s.rows * 0.05)) roles.push("concept");
  if (kind === "integer" && !roles.includes("flag") && !roles.includes("key") && s.distinct >= 2 && s.distinct <= Math.min(30, s.rows * 0.05)) roles.push("concept");
  return roles;
}

/** Chains of columns, coarse to fine, from the "each value of this sits under one value of that" edges (child -> its possible parents). */
export function chainsFromEdges(concept: { name: string; distinct: number }[], edge: Map<string, Set<string>>): string[][] {
  const names = concept.map((c) => c.name).filter((n) => edge.has(n) || [...edge.values()].some((x) => x.has(n)));
  const byCoarse = [...names].sort((x, y) => concept.find((c) => c.name === x)!.distinct - concept.find((c) => c.name === y)!.distinct);
  const chains: string[][] = [];
  const used = new Set<string>();
  for (const root of byCoarse) {
    if (used.has(root)) continue;
    const chain = [root];
    for (const next of byCoarse) if (next !== root && !used.has(next) && chain.every((c) => edge.get(next)?.has(c))) chain.push(next);
    if (chain.length >= 2) {
      chain.forEach((c) => used.add(c));
      chains.push(chain);
    }
  }
  return chains;
}

function profileTable(db: SqlDb, table: string): TableProfile {
  const rows = scalar(db, `SELECT COUNT(*) FROM ${q(table)}`);
  const info = rowsOf(db, `PRAGMA table_info(${q(table)})`);
  const columns: ColumnProfile[] = info.map((c) => {
    const name = String(c.name);
    const declared = String(c.type).toUpperCase();
    const stats = rowsOf(db, `SELECT COUNT(*) - COUNT(${q(name)}) AS nulls, COUNT(DISTINCT ${q(name)}) AS d, MIN(${q(name)}) AS lo, MAX(${q(name)}) AS hi FROM ${q(table)}`)[0];
    const samples = rowsOf(db, `SELECT DISTINCT ${q(name)} AS v FROM ${q(table)} WHERE ${q(name)} IS NOT NULL LIMIT 5`).map((r) => r.v as string | number);
    const numeric = declared === "INTEGER" || declared === "REAL";
    const text = String(stats.lo ?? "");
    const dateLike = !numeric && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(text) && /^\d{4}-\d{2}-\d{2}/.test(String(stats.hi ?? ""));
    const datetime = dateLike && text.length > 10;
    const distinct = Number(stats.d);
    const kind: Kind = dateLike ? (datetime ? "datetime" : "date") : declared === "INTEGER" ? "integer" : declared === "REAL" ? "real" : "text";
    const roles = columnRoles(kind, { rows, nulls: Number(stats.nulls), distinct, lo: stats.lo, hi: stats.hi });
    return { name, type: dateLike ? (datetime ? "datetime" : "date") : numeric ? declared.toLowerCase() : "text", nulls: Number(stats.nulls), distinct, samples, ...(stats.lo !== null ? { min: stats.lo as string | number, max: stats.hi as string | number } : {}), roles };
  });
  return { table, rows, columns };
}

function joinCandidates(db: SqlDb, profiles: TableProfile[]): JoinCandidate[] {
  const out: JoinCandidate[] = [];
  for (const a of profiles) {
    for (const b of profiles) {
      if (a.table === b.table) continue;
      for (const ca of a.columns) {
        const cb = b.columns.find((c) => c.name === ca.name && (c.type === ca.type || (c.type.startsWith("int") && ca.type.startsWith("int"))));
        if (!cb || ca.roles.includes("time") || ca.roles.includes("flag") || ca.roles.includes("measure")) continue;
        const aKey = ca.roles.includes("key");
        const bKey = cb.roles.includes("key");
        // each pair once, from the side that repeats towards the side that is unique
        if (!bKey && (aKey || a.table > b.table)) continue;
        const covered = scalar(db, `SELECT COUNT(*) FROM (SELECT DISTINCT ${q(ca.name)} AS v FROM ${q(a.table)} WHERE ${q(ca.name)} IS NOT NULL) x WHERE v IN (SELECT ${q(cb.name)} FROM ${q(b.table)})`);
        const coverage = ca.distinct === 0 ? 0 : covered / ca.distinct;
        if (coverage < 0.5) continue;
        const unmatched = scalar(db, `SELECT COUNT(*) FROM ${q(a.table)} WHERE ${q(ca.name)} IS NOT NULL AND ${q(ca.name)} NOT IN (SELECT ${q(cb.name)} FROM ${q(b.table)})`);
        out.push({ from: `${a.table}.${ca.name}`, to: `${b.table}.${cb.name}`, shape: bKey ? (aKey ? "one_to_one" : "many_to_one") : "many_to_many", coverage: Math.round(coverage * 1000) / 1000, unmatched_rows: unmatched });
      }
    }
  }
  return out;
}

/** Columns where each value of the finer one sits under exactly one value of the coarser one (a child under exactly one parent). */
function hierarchyCandidates(db: SqlDb, p: TableProfile): HierarchyCandidate[] {
  // a table whose columns are all names and keys is a list of places or products: its key is a level too.
  // In a table of events the key just identifies each event and is not a level of anything.
  const isList = p.columns.every((c) => c.roles.includes("concept") || c.roles.includes("key"));
  const concept = p.columns.filter((c) => c.roles.includes("concept") || (isList && c.roles.includes("key"))).slice(0, 30);
  const belongs = (child: ColumnProfile, parent: ColumnProfile) =>
    child.distinct > parent.distinct && scalar(db, `SELECT COUNT(*) FROM (SELECT ${q(child.name)} FROM ${q(p.table)} GROUP BY ${q(child.name)} HAVING COUNT(DISTINCT ${q(parent.name)}) > 1)`) === 0;
  const edge = new Map<string, Set<string>>();
  for (const child of concept) for (const parent of concept) if (child !== parent && belongs(child, parent)) edge.set(child.name, (edge.get(child.name) ?? new Set()).add(parent.name));
  const chains = chainsFromEdges(concept, edge);
  return chains.map((levels) => ({ table: p.table, levels }));
}

/** Look at the connected data and suggest what it contains. Read-only; everything here is a suggestion for the user to confirm. */
export async function describeData(workspace: string): Promise<DataDescription> {
  if (readState(workspace)?.dialect === "bigquery") {
    const data = await openData(workspace);
    try {
      return await describeRemote(workspace, data);
    } finally {
      await data.close();
    }
  }
  const db = await openDb(join(workspace, "data", "causeline.db"));
  try {
    const tables = rowsOf(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));
    const profiles = tables.map((t) => profileTable(db, t));
    const joins = joinCandidates(db, profiles);
    const hierarchies = profiles.flatMap((p) => hierarchyCandidates(db, p));
    const time: TimeCandidate[] = profiles.flatMap((p) =>
      p.columns
        .filter((c) => c.roles.includes("time"))
        .map((c) => ({ table: p.table, column: c.name, from: String(c.min), to: String(c.max), days: Math.round((Date.parse(String(c.max).slice(0, 10)) - Date.parse(String(c.min).slice(0, 10))) / 86_400_000) + 1 })),
    );
    const ask: string[] = [];
    const timeByTable = new Map<string, TimeCandidate[]>();
    for (const t of time) timeByTable.set(t.table, [...(timeByTable.get(t.table) ?? []), t]);
    for (const [table, list] of timeByTable) if (list.length > 1) ask.push(`${table} has ${list.length} date columns (${list.map((l) => l.column).join(", ")}): which one says when an event happened?`);
    // two columns that always go together (a child and a label for it) are the same thing or one sits under the other
    for (const p of profiles) {
      const cs = p.columns.filter((c) => c.roles.includes("concept") || c.roles.includes("key"));
      for (const x of cs) for (const y of cs) {
        if (x.name < y.name && x.distinct === y.distinct && x.distinct > 1 && scalar(db, `SELECT COUNT(*) FROM (SELECT ${q(x.name)} FROM ${q(p.table)} GROUP BY ${q(x.name)} HAVING COUNT(DISTINCT ${q(y.name)}) > 1)`) === 0) ask.push(`${p.table}: ${x.name} and ${y.name} always go together (${x.distinct} values each): are they the same thing, or is one a finer level of the other?`);
      }
    }
    // a link between two tables of events is expected to repeat on both sides; it only matters for an identifier
    const many = joins.filter((j) => j.shape === "many_to_many" && /(^|_)(id|key|code)$/.test(j.from.split(".")[1]));
    for (const j of many) ask.push(`${j.from} and ${j.to} repeat on both sides, so joining them would multiply rows: is one of them the wrong column?`);
    for (const j of joins.filter((x) => x.unmatched_rows > 0)) ask.push(`${j.unmatched_rows} rows of ${j.from} have no match in ${j.to}: is that expected?`);
    const out: DataDescription = { tables: profiles, joins, hierarchies, time, ask, notes: endNotes(time) };
    updateState(workspace, (s) => {
      s.profiled = true;
    });
    return out;
  } finally {
    db.close();
  }
}

/** A fixed end date: when the data stopped long ago, "last week" should mean the last week it holds. */
export function endNotes(time: TimeCandidate[], today = new Date()): string[] {
  const ends = time.map((t) => ({ t, end: Date.parse(`${String(t.to).slice(0, 10)}T00:00:00Z`) })).filter((x) => !Number.isNaN(x.end));
  const old = ends.filter((x) => (today.getTime() - x.end) / 86_400_000 > 45);
  return old.length === 0 ? [] : [`${old.map((x) => `${x.t.table}.${x.t.column} ends on ${String(x.t.to).slice(0, 10)}`).join("; ")}, well before today: this looks like data that stopped, so set \`as_of: data_end\` in the data definition and "last week" will mean the last week the data holds`];
}
