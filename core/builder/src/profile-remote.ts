import { BudgetError, type BuilderData, type ColumnInfo, type DataTable } from "./data.js";
import { chainsFromEdges, columnRoles, endNotes, type ColumnProfile, type DataDescription, type HierarchyCandidate, type JoinCandidate, type Kind, type TableProfile, type TimeCandidate } from "./profile.js";
import { updateState } from "./state.js";

// How a BigQuery type reads to the profile. Anything not listed (arrays, records, bytes, json, geography) is left out and said so.
const KIND: Record<string, { kind: Kind; shown: string }> = {
  STRING: { kind: "text", shown: "text" },
  INTEGER: { kind: "integer", shown: "integer" },
  INT64: { kind: "integer", shown: "integer" },
  FLOAT: { kind: "real", shown: "real" },
  FLOAT64: { kind: "real", shown: "real" },
  NUMERIC: { kind: "real", shown: "real" },
  BIGNUMERIC: { kind: "real", shown: "real" },
  BOOLEAN: { kind: "bool", shown: "boolean" },
  BOOL: { kind: "bool", shown: "boolean" },
  DATE: { kind: "date", shown: "date" },
  DATETIME: { kind: "datetime", shown: "datetime" },
  TIMESTAMP: { kind: "datetime", shown: "timestamp" },
};

/** A text column whose values are sentences, not labels: it is left out of the profile, since it costs more to read than all the others together. */
const FREE_TEXT = { avg: 80, max: 400 };
/** The most a sample should read, in bytes, and the most concept columns checked for hierarchies. */
const SAMPLE_BYTES = 100e6;
const SCAN_FALLBACK_BYTES = 1e9;
const MAX_HIERARCHY_COLUMNS = 8;
/** An approximate distinct count is within about 1% on these columns, so "every value different" is read with this much room. */
const KEY_TOLERANCE = 0.97;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const gb = (bytes: number) => `${Math.round(bytes / 1e8) / 10} GB`;
const sampleClause = (percent: number | null) => (percent === null ? "" : ` TABLESAMPLE SYSTEM (${Math.max(0.001, Math.min(100, percent))} PERCENT)`);

/**
 * Look at tables on a metered database (BigQuery) and describe them the way `describeData` does for local files,
 * reading as little as possible: the column list and sizes come free from the table's metadata; one small sample finds
 * the free-text columns (which are then not read at all) and the example values; one aggregate pass over the rest gives
 * empty counts, approximate distinct counts and ranges; one more checks which columns sit under which. When a pass
 * would pass the budget it is run on a sample instead, and the result says so. A view is never sampled.
 */
export async function describeRemote(workspace: string, data: BuilderData): Promise<DataDescription> {
  const tables = await data.tables();
  if (tables.length === 0) throw new Error("no tables are connected; connect a table or a dataset first");
  const notes: string[] = [];
  const profiles: TableProfile[] = [];
  const concepts = new Map<string, { names: { name: string; distinct: number }[]; sampled: boolean; rows: number }>();
  for (const t of tables) {
    const profile = await profileTable(data, t, notes);
    profiles.push(profile.table);
    concepts.set(t.name, { names: profile.concepts, sampled: profile.sampled, rows: profile.table.rows });
  }

  const ask: string[] = [];
  const hierarchies: HierarchyCandidate[] = [];
  for (const t of tables) {
    const c = concepts.get(t.name)!;
    if (c.sampled) {
      notes.push(`${t.name}: hierarchies were not looked for, because the table was only sampled and a sample cannot show that each value sits under exactly one other`);
      continue;
    }
    hierarchies.push(...(await hierarchiesOf(data, t, c.names, ask)));
  }

  const joins = await joinsOf(data, tables, profiles);
  const time: TimeCandidate[] = profiles.flatMap((p) =>
    p.columns
      .filter((c) => c.roles.includes("time"))
      .map((c) => ({ table: p.table, column: c.name, from: String(c.min), to: String(c.max), days: Math.round((Date.parse(String(c.max).slice(0, 10)) - Date.parse(String(c.min).slice(0, 10))) / 86_400_000) + 1 })),
  );
  for (const p of profiles) {
    const list = time.filter((x) => x.table === p.table);
    if (list.length > 1) ask.push(`${p.table} has ${list.length} date columns (${list.map((l) => l.column).join(", ")}): which one says when an event happened?`);
  }
  for (const j of joins.filter((x) => x.unmatched_rows > 0)) ask.push(`${j.unmatched_rows} rows of ${j.from} have no match in ${j.to}: is that expected?`);
  notes.push(...endNotes(time));
  if (time.some((t) => profiles.find((p) => p.table === t.table)?.columns.find((c) => c.name === t.column)?.type === "date")) {
    notes.push("a DATE column is not enough on BigQuery: the time column of a fact must be a TIMESTAMP, so write TIMESTAMP(column) in the fact's SELECT");
  }
  updateState(workspace, (s) => {
    s.profiled = true;
  });
  const used = data.usage();
  return { tables: profiles, joins, hierarchies, time, ask, notes, ...(used ? { cost: used } : {}) };
}

interface Profiled {
  table: TableProfile;
  concepts: { name: string; distinct: number }[];
  sampled: boolean;
}

async function profileTable(data: BuilderData, t: DataTable, notes: string[]): Promise<Profiled> {
  const q = (c: string) => data.quote(c);
  const ref = data.ref(t.name);
  const usable = t.columns.filter((c) => !c.repeated && KIND[c.type]);
  const left = t.columns.filter((c) => !usable.includes(c));
  if (left.length > 0) notes.push(`${t.name}: left out ${left.map((c) => `${c.name} (${c.repeated ? "a list" : c.type.toLowerCase()})`).join(", ")}, which cannot be profiled`);
  if (usable.length === 0) return { table: { table: t.name, rows: t.rows ?? 0, columns: [] }, concepts: [], sampled: false };

  // one small sample: example values, and which text columns are really free text
  const small = t.kind === "view" || (t.bytes ?? 0) <= 2 * SAMPLE_BYTES;
  const percent = small ? null : Math.min(100, (SAMPLE_BYTES / (t.bytes as number)) * 100);
  const sample = await data.query(`SELECT ${usable.map((c) => q(c.name)).join(", ")} FROM ${ref}${sampleClause(percent)} LIMIT 500`);
  const freeText = new Set<string>();
  for (const c of usable.filter((x) => KIND[x.type].kind === "text")) {
    const lengths = sample.rows.map((r) => r[c.name]).filter((v) => v !== null && v !== undefined).map((v) => String(v).length);
    if (lengths.length === 0) continue;
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (avg > FREE_TEXT.avg || Math.max(...lengths) > FREE_TEXT.max) freeText.add(c.name);
  }
  if (freeText.size > 0) notes.push(`${t.name}: left out ${[...freeText].join(", ")}, which hold${freeText.size === 1 ? "s" : ""} free text (long sentences); reading ${freeText.size === 1 ? "it" : "them"} would cost far more than the rest and says nothing about places, products or people`);
  const columns = usable.filter((c) => !freeText.has(c.name));

  // one aggregate pass over the rest; on a sample if the whole would pass the budget
  const stat = (c: ColumnInfo, i: number) => {
    const k = KIND[c.type].kind;
    return [`COUNTIF(${q(c.name)} IS NULL) AS nulls_${i}`, `APPROX_COUNT_DISTINCT(${q(c.name)}) AS d_${i}`, ...(k === "bool" ? [] : [`CAST(MIN(${q(c.name)}) AS STRING) AS lo_${i}`, `CAST(MAX(${q(c.name)}) AS STRING) AS hi_${i}`])];
  };
  const aggregate = (pct: number | null) => `SELECT COUNT(*) AS n, ${columns.flatMap(stat).join(", ")} FROM ${ref}${sampleClause(pct)}`;
  let sampled = false;
  let res;
  try {
    res = await data.query(aggregate(null));
  } catch (e) {
    if (!(e instanceof BudgetError) || t.kind === "view") throw e;
    const bytes = (await data.check(aggregate(null))).bytes ?? t.bytes ?? SCAN_FALLBACK_BYTES * 10;
    sampled = true;
    notes.push(`${t.name}: reading the whole table would pass the limit for one question (${gb(bytes)}), so these counts come from a sample of about ${gb(SCAN_FALLBACK_BYTES)}; empty and distinct counts are estimates`);
    res = await data.query(aggregate(Math.min(100, (SCAN_FALLBACK_BYTES / bytes) * 100)));
  }
  const row = res.rows[0] ?? {};
  const read = num(row.n);
  const rows = sampled ? (t.rows ?? read) : read;
  const scale = sampled && read > 0 ? rows / read : 1;
  const profiled: ColumnProfile[] = columns.map((c, i) => {
    const { kind, shown } = KIND[c.type];
    const nulls = Math.round(num(row[`nulls_${i}`]) * scale);
    const distinct = num(row[`d_${i}`]);
    const lo = kind === "bool" ? null : (row[`lo_${i}`] as string | null);
    const hi = kind === "bool" ? null : (row[`hi_${i}`] as string | null);
    const samples = [...new Set(sample.rows.map((r) => r[c.name]).filter((v) => v !== null && v !== undefined).map((v) => (typeof v === "number" ? v : String(v))))].slice(0, 5);
    const roles = columnRoles(kind, { rows, nulls, distinct, lo, hi, keyTolerance: KEY_TOLERANCE });
    return { name: c.name, type: shown, nulls, distinct, samples, ...(lo !== null && lo !== undefined ? { min: kind === "integer" || kind === "real" ? Number(lo) : lo, max: kind === "integer" || kind === "real" ? Number(hi) : (hi as string) } : {}), roles };
  });
  // the columns that repeat, for the hierarchy check: the ones with the fewest values come first
  // a table that is only names and keys is a list of places or products: its key is a level too (as for local files)
  const isList = profiled.every((c) => c.roles.includes("concept") || c.roles.includes("key"));
  const concept = profiled.filter((c) => (c.roles.includes("concept") || (isList && c.roles.includes("key"))) && c.distinct >= 2).sort((a, b) => a.distinct - b.distinct).slice(0, MAX_HIERARCHY_COLUMNS);
  return { table: { table: t.name, rows, columns: profiled }, concepts: concept.map((c) => ({ name: c.name, distinct: c.distinct })), sampled };
}

/** Which of these columns sit under exactly one value of another: one pass counting each value, and each (parent, value) pair. */
async function hierarchiesOf(data: BuilderData, t: DataTable, concept: { name: string; distinct: number }[], ask: string[]): Promise<HierarchyCandidate[]> {
  if (concept.length < 2) return [];
  const q = (c: string) => data.quote(c);
  const pairs: { child: string; parent: string }[] = [];
  for (const child of concept) for (const parent of concept) if (child !== parent && child.distinct > parent.distinct * 1.05) pairs.push({ child: child.name, parent: parent.name });
  if (pairs.length === 0) return [];
  const select = [...concept.map((c, i) => `COUNT(DISTINCT ${q(c.name)}) AS c_${i}`), ...pairs.map((p, i) => `COUNT(DISTINCT CONCAT(CAST(${q(p.parent)} AS STRING), '|', CAST(${q(p.child)} AS STRING))) AS p_${i}`)];
  let row: Record<string, unknown>;
  try {
    row = (await data.query(`SELECT ${select.join(", ")} FROM ${data.ref(t.name)}`)).rows[0] ?? {};
  } catch (e) {
    if (e instanceof BudgetError) return [];
    throw e;
  }
  const exact = new Map(concept.map((c, i) => [c.name, num(row[`c_${i}`])]));
  const edge = new Map<string, Set<string>>();
  const near = new Map<string, { parent: string; pairs: number; child: number }>();
  pairs.forEach((p, i) => {
    const [together, child] = [num(row[`p_${i}`]), exact.get(p.child) ?? 0];
    if (together === child) edge.set(p.child, (edge.get(p.child) ?? new Set()).add(p.parent));
    // almost a level: most values sit under one parent, a few (a name like "Other") under several
    else if (child > 0 && together > child && together <= child * 1.5 && (near.get(p.child)?.pairs ?? Infinity) > together) near.set(p.child, { parent: p.parent, pairs: together, child });
  });
  for (const [child, n] of near) {
    if (edge.has(child)) continue;
    ask.push(`${t.name}: ${child} is close to being a level under ${n.parent}, but ${n.pairs - n.child} of its ${n.child} values appear under more than one ${n.parent} (a name like "Other" used in several places). To use it as a level, make its name unique in the fact's SELECT (for example ${n.parent} and ${child} joined into one text), or say it is not a level.`);
  }
  return chainsFromEdges(concept, edge).map((levels) => ({ table: t.name, levels }));
}

/** Columns of the same name and kind in two tables, one side unique: coverage and unmatched rows, read from just those two columns. */
async function joinsOf(data: BuilderData, tables: DataTable[], profiles: TableProfile[]): Promise<JoinCandidate[]> {
  const out: JoinCandidate[] = [];
  const q = (c: string) => data.quote(c);
  for (const a of profiles) {
    for (const b of profiles) {
      if (a.table === b.table) continue;
      for (const ca of a.columns) {
        const cb = b.columns.find((c) => c.name === ca.name && c.type === ca.type);
        if (!cb || ca.roles.includes("time") || ca.roles.includes("flag") || ca.roles.includes("measure")) continue;
        const aKey = ca.roles.includes("key");
        const bKey = cb.roles.includes("key");
        if (!bKey && (aKey || a.table > b.table)) continue;
        const [refA, refB] = [data.ref(a.table), data.ref(b.table)];
        const row = (await data.query(`SELECT (SELECT COUNT(*) FROM (SELECT DISTINCT ${q(ca.name)} AS v FROM ${refA} WHERE ${q(ca.name)} IS NOT NULL) WHERE v IN (SELECT ${q(cb.name)} FROM ${refB} WHERE ${q(cb.name)} IS NOT NULL)) AS covered, (SELECT COUNT(*) FROM ${refA} WHERE ${q(ca.name)} IS NOT NULL AND ${q(ca.name)} NOT IN (SELECT ${q(cb.name)} FROM ${refB} WHERE ${q(cb.name)} IS NOT NULL)) AS unmatched`)).rows[0] ?? {};
        const coverage = ca.distinct === 0 ? 0 : num(row.covered) / ca.distinct;
        if (coverage < 0.5) continue;
        out.push({ from: `${a.table}.${ca.name}`, to: `${b.table}.${cb.name}`, shape: bKey ? (aKey ? "one_to_one" : "many_to_one") : "many_to_many", coverage: Math.round(coverage * 1000) / 1000, unmatched_rows: num(row.unmatched) });
      }
    }
  }
  void tables;
  return out;
}
