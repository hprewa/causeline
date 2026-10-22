import { describeRemote } from "./profile-remote.js";
import { BudgetError, openData, type BuilderData, type DataTable } from "./data.js";
import type { ColumnProfile, DataDescription } from "./profile.js";
import { readState } from "./state.js";

const STOP = new Set(["the", "a", "an", "of", "per", "by", "for", "and", "or", "to", "in", "on", "at", "is", "are", "was", "were", "how", "many", "much", "what", "which", "number", "total", "count", "average", "avg", "rate", "my", "our", "we", "i", "it", "with", "from", "do", "does", "did", "than", "that", "this", "each", "every", "all", "any"]);

/** A word without its ending, so "items" meets "item" and "entries" meets "entry". */
const stem = (w: string) => (w.length > 5 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 4 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** The meaningful words of a text or a column name (split on punctuation, underscores and camelCase). */
export function wordsOf(text: string): string[] {
  return [...new Set(text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem))];
}

const DATE_TYPES = new Set(["DATE", "TIMESTAMP", "DATETIME"]);

export interface ShortlistedTable {
  table: string;
  score: number;
  /** Why it was picked, in plain words. */
  why: string[];
  bytes?: number;
  rows?: number;
  has_time: boolean;
}

export interface Shortlist {
  /** The tables that match the KPI's words, best first. */
  matches: ShortlistedTable[];
  /** Tables that share a column with a match and may be needed to describe it (a list of places, products, people). Not picked. */
  related: { table: string; shares: string; with: string }[];
  /** True when nothing matched, so every table is offered. */
  nothing_matched: boolean;
}

/**
 * Which tables a KPI is likely to need, from the table list alone (names, columns, sizes: free). Plain word matching on the KPI's words, kept
 * so it is deterministic and can be explained: a word in a table's name counts most, a word in a column's name counts less, and a date column
 * breaks ties because a KPI is counted over time.
 */
export function shortlistTables(tables: DataTable[], kpiText: string): Shortlist {
  const words = wordsOf(kpiText);
  const scored: ShortlistedTable[] = tables.map((t) => {
    const nameWords = new Set(wordsOf(t.name.split(".").pop() ?? t.name));
    const why: string[] = [];
    let score = 0;
    for (const w of words) if (nameWords.has(w)) (score += 3), why.push(`its name has "${w}"`);
    const colHits = new Map<string, string[]>();
    for (const c of t.columns) for (const cw of wordsOf(c.name)) if (words.includes(cw)) colHits.set(cw, [...(colHits.get(cw) ?? []), c.name]);
    for (const [w, cols] of colHits) (score += 2), why.push(`${cols.length === 1 ? "a column" : "columns"} named ${cols.slice(0, 3).join(", ")} match "${w}"`);
    const has_time = t.columns.some((c) => DATE_TYPES.has(c.type));
    if (score > 0 && has_time) (score += 1), why.push("it has a date column");
    return { table: t.name, score, why, ...(t.bytes !== undefined ? { bytes: t.bytes } : {}), ...(t.rows !== undefined ? { rows: t.rows } : {}), has_time };
  });
  const matches = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.table.localeCompare(b.table));
  if (matches.length === 0) return { matches: scored.sort((a, b) => a.table.localeCompare(b.table)), related: [], nothing_matched: true };
  const picked = new Set(matches.map((m) => m.table));
  const related: Shortlist["related"] = [];
  for (const t of tables) {
    if (picked.has(t.name)) continue;
    for (const m of matches.slice(0, 3)) {
      const mt = tables.find((x) => x.name === m.table)!;
      const shared = t.columns.find((c) => !DATE_TYPES.has(c.type) && mt.columns.some((d) => d.name === c.name && d.type === c.type));
      if (shared) {
        related.push({ table: t.name, shares: shared.name, with: m.table });
        break;
      }
    }
  }
  return { matches, related, nothing_matched: false };
}

const TEST_WORDS = /\b(test|testing|cancel(l)?ed|void(ed)?|duplicate|deleted|dummy|sandbox|draft|trial|demo)\b/i;
const STATUS_NAME = /(status|state|type|kind|flag|category|stage|is_)/i;
const RATE_NAME = /(rate|pct|percent|percentage|ratio|share|score|proportion)/i;

/**
 * Risks that show in the profile itself, for the person to confirm. Each says what was seen and what to ask; none changes anything.
 * Values seen are the few samples the profile keeps, so absence here is not proof of absence.
 */
export function profileRisks(description: DataDescription): string[] {
  const out: string[] = [];
  for (const t of description.tables) {
    for (const c of t.columns) {
      if (STATUS_NAME.test(c.name) && c.roles.includes("concept")) {
        const bad = c.samples.map(String).filter((v) => TEST_WORDS.test(v));
        if (bad.length > 0) out.push(`${t.table}.${c.name} has values like ${bad.slice(0, 3).map((b) => `"${b}"`).join(", ")}: should those rows count? (Only a few values were looked at, so others may exist.)`);
      }
      if (RATE_NAME.test(c.name) && c.roles.includes("measure") && typeof c.min === "number" && typeof c.max === "number") {
        if (c.max <= 1 && c.min >= 0) out.push(`${t.table}.${c.name} runs from ${c.min} to ${c.max}: is that a fraction (0 to 1) rather than a percent (0 to 100)?`);
        else if (c.max <= 100 && c.max > 1 && c.min >= 0) out.push(`${t.table}.${c.name} runs from ${c.min} to ${c.max}: is that a percent (0 to 100) rather than a fraction (0 to 1)?`);
      }
    }
    const time = t.columns.filter((c) => c.roles.includes("time"));
    for (const c of time) if (c.nulls > 0 && t.rows > 0) out.push(`${t.table}.${c.name} is empty on ${c.nulls} of ${t.rows} rows (${Math.round((100 * c.nulls) / t.rows)}%): those rows cannot be placed in time.`);
  }
  return out;
}

/** Days with their row counts, newest last. */
export interface DayCount {
  day: string;
  n: number;
}

/**
 * Is the newest data still arriving? A newest day (or two) with far fewer rows than the days before it is probably incomplete, and a KPI
 * for that period would read as a fall that is not real.
 */
export function lateArrival(days: DayCount[]): string | null {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  if (sorted.length < 6) return null;
  const base = sorted.slice(0, -2).map((d) => d.n).sort((a, b) => a - b);
  const typical = base[Math.floor(base.length / 2)];
  if (!(typical > 0)) return null;
  const thin = sorted.slice(-2).filter((d) => d.n < typical * 0.5);
  if (thin.length === 0) return null;
  return `the newest day${thin.length > 1 ? "s" : ""} (${thin.map((d) => `${d.day}: ${d.n} rows`).join(", ")}) ${thin.length > 1 ? "are" : "is"} much thinner than a typical day (about ${typical} rows): data for it may still be arriving, so do not read the latest period as a real fall.`;
}

/** The profile in the sentences a person is asked to confirm. */
export function draftSentences(kpi: string, description: DataDescription): string[] {
  const out: string[] = [];
  for (const t of description.tables) {
    const time = description.time.filter((x) => x.table === t.table);
    const when = time.length === 1 ? ` by ${time[0].column}, from ${time[0].from.slice(0, 10)} to ${time[0].to.slice(0, 10)}` : time.length > 1 ? ` (it has several date columns: ${time.map((x) => x.column).join(", ")})` : " (no date column found)";
    out.push(`"${kpi}" would be counted from ${t.table}: ${t.rows.toLocaleString("en-US")} rows${when}.`);
    const by = (role: string) => t.columns.filter((c: ColumnProfile) => c.roles.includes(role)).map((c) => c.name);
    const concepts = by("concept");
    if (concepts.length > 0) out.push(`${t.table} can be broken down by ${concepts.slice(0, 8).join(", ")}${concepts.length > 8 ? " and more" : ""}.`);
    const measures = by("measure");
    if (measures.length > 0) out.push(`${t.table} has numbers that could be added up or averaged: ${measures.slice(0, 8).join(", ")}.`);
    const flags = by("flag");
    if (flags.length > 0) out.push(`${t.table} has yes/no columns: ${flags.slice(0, 6).join(", ")}.`);
  }
  for (const h of description.hierarchies) out.push(`In ${h.table}, ${h.levels.join(" sits inside ")} look nested.`);
  for (const j of description.joins) out.push(`${j.from} links to ${j.to}${j.unmatched_rows > 0 ? `, but ${j.unmatched_rows} rows have no match` : ", every row matched"}.`);
  return out;
}

export interface Discovery {
  stage: "shortlist" | "draft";
  say: string;
  shortlist?: Shortlist;
  draft?: string[];
  risks?: string[];
  questions?: string[];
  description?: DataDescription;
  next: string;
}

/** The days of the newest fortnight of one table's time column, for the late-arrival check. Reads that one column; the budget refuses it if too large. */
async function recentDays(data: BuilderData, table: string, column: string): Promise<DayCount[] | string> {
  const t = data.ref(table);
  const c = data.quote(column);
  try {
    const r = await data.query(`SELECT CAST(${c} AS STRING) AS d, COUNT(*) AS n FROM (SELECT CAST(${c} AS DATE) AS ${c} FROM ${t}) GROUP BY d ORDER BY d DESC LIMIT 16`);
    return r.rows.map((x) => ({ day: String(x.d), n: Number(x.n) })).reverse();
  } catch (e) {
    return e instanceof BudgetError ? "the check for data still arriving was skipped because it would read too much" : "the check for data still arriving could not be run";
  }
}

/**
 * Discovery that starts from one KPI. Without `tables` it reads nothing: it lists the connected tables that fit the KPI's words, for the
 * person to confirm. With `tables` it profiles only those, then returns the draft in sentences, the risks seen and the questions to ask.
 */
export async function discoverForKpi(opts: { workspace: string; kpi: string; hint?: string; tables?: string[] }): Promise<Discovery> {
  if (!opts.kpi.trim()) throw new Error("say which KPI to start from, in the user's words");
  const state = readState(opts.workspace);
  if (state?.dialect !== "bigquery") throw new Error("discovery from a KPI looks at a cloud database; connect a dataset first (connect_bigquery)");
  const data = await openData(opts.workspace);
  try {
    const all = await data.tables();
    if (!opts.tables || opts.tables.length === 0) {
      const sl = shortlistTables(all, `${opts.kpi} ${opts.hint ?? ""}`);
      const say = sl.nothing_matched
        ? `None of the ${all.length} tables has a name or column that matches "${opts.kpi}". Here they all are; which of them holds what you count?`
        : `For "${opts.kpi}" the best fits are ${sl.matches.slice(0, 3).map((m) => m.table.split(".").pop()).join(", ")}. Does that look right?`;
      return { stage: "shortlist", say, shortlist: sl, next: "Read the user this list in plain words (not the scores) and ask which tables to look at. Then call discover_for_kpi again with those tables." };
    }
    const chosen = opts.tables.map((n) => {
      const t = all.find((x) => x.name === n || x.name.split(".").pop() === n);
      if (!t) throw new Error(`${n} is not one of the connected tables (${all.map((x) => x.name.split(".").pop()).join(", ")})`);
      return t;
    });
    const scoped = Object.create(data, { tables: { value: async () => chosen } }) as BuilderData;
    const description = await describeRemote(opts.workspace, scoped);
    const risks = profileRisks(description);
    for (const tc of description.time.slice(0, 3)) {
      const days = await recentDays(data, tc.table, tc.column);
      const late = typeof days === "string" ? days : lateArrival(days);
      if (late) risks.push(`${tc.table}.${tc.column}: ${late}`);
    }
    const draft = draftSentences(opts.kpi, description);
    const questions = [...description.ask, ...risks.filter((r) => r.includes("?"))];
    return {
      stage: "draft",
      say: `I looked at ${chosen.length} table${chosen.length === 1 ? "" : "s"} only, not the whole dataset. ${questions.length > 0 ? `${questions.length} thing${questions.length === 1 ? "" : "s"} to check with you.` : "Nothing in the data itself worries me yet."}`,
      draft,
      risks,
      questions,
      description,
      next: "Read the draft sentences to the user and ask if each is right; ask each question one at a time; then carry on with the business description as usual (the draft is a suggestion, not a decision).",
    };
  } finally {
    await data.close();
  }
}
