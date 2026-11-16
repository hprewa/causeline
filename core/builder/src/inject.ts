import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { scoreRunner } from "@causeline/eval";
import { generateForPack } from "@causeline/generate";
import { loadPlaybook, MIN_DISPERSION_PERIODS, rawExcess, runPlaybook, shrinkSpreads, SPREAD_PERIODS, type Components } from "@causeline/runner";
import { loadPack, type Expectation, type PackDefinition, type Result } from "@causeline/schema";
import { kpiKey, quietPeriods, type PeriodOutcome } from "./calibrate.js";
import { logChange, levelOf, readState, updateState, type Level } from "./state.js";
import { openDb, q, rowsOf, saveDb, type SqlDb } from "./db.js";
import { SqliteToolCaller } from "./sqlite-tools.js";
import { syncExperts } from "./checks.js";

/**
 * Fault injection on the person's own data: the surest way to `verified` when they know of few or no past incidents. Take a recent period in
 * which the analysis raised nothing, plant a known fault in a COPY of their data (a shift in one part, an offsetting pair, a move of volume
 * between two parts, a part whose data goes missing), and check that the analysis finds what was planted and declines when the data is missing.
 * The planted faults are made by adding or removing whole rows of the copy, so they work for any KPI formula and any database layout. The
 * person's own data is never touched, and a fault is reproduced from its seed.
 *
 * Files and local databases only for now: a cloud database is read-only and would need a capped extract first.
 */

export type FaultKind = "segment_shift" | "offsetting_pair" | "mix_shift" | "data_gap";

export interface FaultOutcome {
  id: string;
  kind: FaultKind;
  applicable: boolean;
  /** What was planted, in words; or why this kind cannot be planted in this data. */
  what: string;
  pass: boolean;
  /** What failed, when it did. */
  detail?: string;
  at: string;
}

interface FaultsFile {
  version: 1;
  kpi: string;
  key: string;
  seed: number;
  sigmas?: number;
  period: string;
  start: string;
  end: string;
  /** The same window, left alone: it must still raise nothing, or the faults prove nothing. */
  control?: { quiet: boolean; detail: string };
  outcomes: Record<string, FaultOutcome>;
  /** The same faults planted smaller, by size: tried only after everything at the default size was found. */
  smaller?: Record<string, Record<string, FaultOutcome>>;
}

export const FAULT_KINDS: FaultKind[] = ["segment_shift", "offsetting_pair", "mix_shift", "data_gap"];
/**
 * The smaller sizes tried, largest first, once every fault at the default size is found; it stops at the first size where one is missed. They
 * do not decide the rung: they say how small a change the analysis still found in this data, which the answer then states.
 */
export const SMALLER_SIZES = [4, 3, 2];
const CHUNK_MS = 40_000;
/**
 * A planted change is sized to be about this many standard errors for the part it is planted in, so that it is real enough for an honest test (a
 * smaller size measures how small a fault the analysis still finds). The standard error is the one the analysis itself judges that part by:
 * counting noise plus the part's own period-to-period spread (see `detectorSpread`). Sized on counting noise alone, a "six standard error" fault
 * in data that moves from week to week sat inside ordinary movement and was rightly not reported.
 */
export const DEFAULT_SIGMAS = 6;
/** The most of a part's rows that a planted change may touch, and the least (a small planted size must be allowed to be small). */
const MAX_SHARE = 0.9;
const MIN_SHARE = 0.02;
/** The share of every other part's rows moved into the worst part in a mix shift (enough to change the whole's rate by several standard errors). */
/** The most of every other part that a mix shift may move. */
const MAX_MOVE = 0.9;
const baseline = 4;
/** Fewest rows a part needs in the window to carry a planted fault that can be told from chance. */
const MIN_PART_ROWS = 60;

const fileOf = (workspace: string, kpi: string) => join(workspace, `faults-${kpi}.json`);
function readFile(workspace: string, kpi: string): FaultsFile | null {
  const f = fileOf(workspace, kpi);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, "utf-8")) as FaultsFile;
    return raw?.version === 1 ? raw : null;
  } catch {
    return null;
  }
}
const writeFile = (workspace: string, file: FaultsFile) => writeFileSync(fileOf(workspace, file.kpi), JSON.stringify(file, null, 2) + "\n", "utf-8");

/** A small seeded generator, so that a fault is the same every time it is planted. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: T[], share: number, rand: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(1, Math.round(items.length * share)));
}

const inList = (ids: number[]) => ids.join(",");
function chunks<T>(xs: T[], n = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

interface Plan {
  fact: string;
  table: string;
  time: string;
  dimension: string;
  window: { start: string; end: string };
  numerator: string;
  denominator: string;
  kind: "ratio" | "sum";
  higherIsBetter: boolean;
  sigmas: number;
}

/** The extra period-to-period variation the analysis allows for, as it would estimate it: for each part of the dimension, and for the whole. */
interface Spread {
  /** A rate's rho (a multiple of p(1 - p)) or a total's s2 (a multiple of its mean squared) for one part. */
  of(value: string): number;
  whole: number;
  /** Earlier periods it rests on (0: none could be read, and sizes are in counting noise alone). */
  periods: number;
}

const NO_SPREAD: Spread = { of: () => 0, whole: 0, periods: 0 };

/**
 * The spread the analysis judges by, worked out here the way the analysis does it (the runner's own estimator, `shrinkSpreads`): the periods
 * before the window, each as long as the window, up to as many as the analysis reads; each part's excess over counting noise pulled toward the
 * typical excess of the parts; the whole's from its own series, as the headline's is (none with fewer periods than the headline needs). The
 * analysis reads periods with the same calendar flags; here they are simply the periods before, which is the same thing in data with no flags.
 */
function detectorSpread(db: SqlDb, plan: Plan): Spread {
  const day = (s: string) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
  const start = day(plan.window.start);
  const length = day(plan.window.end) - start + 1;
  if (!(length > 0)) return NO_SPREAD;
  const from = new Date((start - SPREAD_PERIODS * length) * 86400000).toISOString().slice(0, 10);
  const num = `(${plan.numerator})`;
  const den = plan.kind === "ratio" ? `(${plan.denominator})` : "1";
  const rows = rowsOf(
    db,
    `SELECT substr(${q(plan.time)}, 1, 10) AS d, ${q(plan.dimension)} AS v, SUM(${num}) AS num, SUM(${den}) AS den, SUM(${num} * ${num}) AS sq FROM ${q(plan.table)} ` +
      `WHERE substr(${q(plan.time)}, 1, 10) >= '${from}' AND substr(${q(plan.time)}, 1, 10) < '${plan.window.start}' AND ${q(plan.dimension)} IS NOT NULL GROUP BY 1, 2`,
  );
  // period 0 is the one just before the window
  const byPart = new Map<string, Map<number, Components>>();
  const whole = new Map<number, Components>();
  const add = (m: Map<number, Components>, k: number, x: Components) => {
    const c = m.get(k) ?? { num: 0, den: 0, sq: 0 };
    m.set(k, { num: c.num + x.num, den: c.den + x.den, sq: (c.sq ?? 0) + (x.sq ?? 0) });
  };
  for (const r of rows) {
    const k = Math.floor((start - 1 - day(String(r.d))) / length);
    if (k < 0 || k >= SPREAD_PERIODS) continue;
    const x = { num: Number(r.num ?? 0), den: Number(r.den ?? 0), sq: Number(r.sq ?? 0) };
    const part = byPart.get(String(r.v)) ?? new Map<number, Components>();
    add(part, k, x);
    byPart.set(String(r.v), part);
    add(whole, k, x);
  }
  const periods = whole.size;
  if (periods === 0) return NO_SPREAD;
  // for a rate the sum of squares is left out, so counting noise is p(1 - p), as it is for the rows the planter swaps
  const series = (m: Map<number, Components>): Components[] => [...m.values()].map((c) => (plan.kind === "ratio" ? { num: c.num, den: c.den } : c));
  const level = shrinkSpreads(new Map([...byPart.entries()].map(([v, m]) => [v, series(m)])), plan.kind, periods);
  const own = periods >= MIN_DISPERSION_PERIODS ? rawExcess(series(whole), plan.kind) : null;
  const excess = (d: { rho: number; s2: number }) => (plan.kind === "ratio" ? d.rho : d.s2);
  return { of: (value) => (level ? excess(level.of(value)) : 0), whole: Math.max(0, own?.excess ?? 0), periods };
}

const where = (plan: Plan) => `substr(${q(plan.time)}, 1, 10) BETWEEN '${plan.window.start}' AND '${plan.window.end}'`;

/** The parts of a dimension in the window, biggest first, with their rows' per-row values (for a rate: numerator over denominator). */
function parts(db: SqlDb, plan: Plan): { value: string; rows: { rid: number; r: number }[] }[] {
  const per = plan.kind === "ratio" ? `(${plan.numerator}) * 1.0 / NULLIF((${plan.denominator}), 0)` : `(${plan.numerator})`;
  const rows = rowsOf(db, `SELECT rowid AS rid, ${q(plan.dimension)} AS v, ${per} AS r FROM ${q(plan.table)} WHERE ${where(plan)} AND ${q(plan.dimension)} IS NOT NULL`);
  const by = new Map<string, { rid: number; r: number }[]>();
  for (const x of rows) {
    if (x.r === null || x.r === undefined) continue;
    const list = by.get(String(x.v)) ?? [];
    list.push({ rid: Number(x.rid), r: Number(x.r) });
    by.set(String(x.v), list);
  }
  return [...by.entries()].map(([value, r]) => ({ value, rows: r })).sort((a, b) => b.rows.length - a.rows.length);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/**
 * How many rows to swap so that the part's rate (or total) moves by about SIGMAS standard errors, as far as the data allows. For a rate, rows that
 * favour the part are replaced by copies of rows that count against it, so the volume does not change (a change in volume is a different fault).
 */
function swapsFor(plan: Plan, rows: { r: number }[], remove: { r: number }[], pool: { r: number }[], extra: number): number {
  const n = rows.length;
  if (plan.kind === "sum") {
    const total = rows.reduce((a, x) => a + x.r, 0);
    // counting noise of the total, plus its own period-to-period spread (`extra` is the squared relative spread)
    const spread = Math.sqrt(rows.reduce((a, x) => a + x.r * x.r, 0) + extra * total * total) * Math.sqrt(1 + 1 / baseline);
    const share = total > 0 ? Math.min(MAX_SHARE, Math.max(MIN_SHARE, (plan.sigmas * spread) / total)) : MAX_SHARE;
    return Math.max(1, Math.round(share * n));
  }
  const m = mean(rows.map((x) => x.r));
  const sd = Math.sqrt(mean(rows.map((x) => (x.r - m) ** 2)));
  // counting noise of the rate, plus its own period-to-period spread (`extra` is a multiple of p(1 - p))
  const se = Math.sqrt((sd * sd) / n + extra * m * (1 - m)) * Math.sqrt(1 + 1 / baseline);
  const gap = Math.abs(mean(pool.map((x) => x.r)) - mean(remove.map((x) => x.r))); // what one swapped row moves the total by
  const needed = gap > 0 ? Math.ceil((plan.sigmas * se * n) / gap) : remove.length;
  return Math.min(Math.round(MAX_SHARE * remove.length), Math.max(1, needed), remove.length);
}

/** Make a part worse (or, with `better`, better), keeping its volume. For a total, add rows (when high is bad) or take them away. */
function shift(db: SqlDb, plan: Plan, part: { value: string; rows: { rid: number; r: number }[] }, rand: () => number, extra: number, better = false): string {
  const m = mean(part.rows.map((x) => x.r));
  const wantsHigh = plan.higherIsBetter !== better; // worse + higher-is-better -> take away the rows that are high
  if (plan.kind === "ratio") {
    const remove = part.rows.filter((x) => (wantsHigh ? x.r > m : x.r < m));
    const pool = part.rows.filter((x) => (wantsHigh ? x.r <= m : x.r >= m));
    if (remove.length === 0 || pool.length === 0) throw new Error(`every row of ${part.value} looks the same, so a shift cannot be planted there`);
    const k = swapsFor(plan, part.rows, remove, pool, extra);
    const gone = pick(remove, k / remove.length, rand);
    const copies: number[] = [];
    for (let i = 0; i < gone.length; i++) copies.push(pool[Math.floor(rand() * pool.length)].rid);
    for (const c of chunks(gone.map((x) => x.rid))) db.run(`DELETE FROM ${q(plan.table)} WHERE rowid IN (${inList(c)})`);
    for (const rid of copies) db.run(`INSERT INTO ${q(plan.table)} SELECT * FROM ${q(plan.table)} WHERE rowid = ${rid}`);
    return `${gone.length} of the ${part.rows.length} rows of ${part.value} that ${better ? "count against it" : "favour it"} were swapped for ones that ${better ? "favour" : "count against"} it`;
  }
  // a total: worse is lower when higher is better, higher otherwise
  const k = swapsFor(plan, part.rows, part.rows, part.rows, extra);
  const chosen = pick(part.rows, k / part.rows.length, rand).map((x) => x.rid);
  if (wantsHigh) {
    for (const c of chunks(chosen)) db.run(`DELETE FROM ${q(plan.table)} WHERE rowid IN (${inList(c)})`);
    return `${chosen.length} of the ${part.rows.length} rows of ${part.value} were taken away`;
  }
  for (const c of chunks(chosen)) db.run(`INSERT INTO ${q(plan.table)} SELECT * FROM ${q(plan.table)} WHERE rowid IN (${inList(c)})`);
  return `${chosen.length} more rows were added to ${part.value}`;
}

interface Planted {
  what: string;
  expect: Expectation;
  /** Overrides the scoring when "found it" is not one expectation (a gap is met by declining, for any reason that is about the data). */
  accepts?: (result: Result) => { pass: boolean; detail?: string };
}

/** Why an analysis may decline when part of the data is missing: its own data checks, or the newest period looking unfinished. */
const DATA_STOPS = ["data_quality", "data_still_arriving", "insufficient_volume"];

/** Plant one kind of fault in the copy's rows, or say why it cannot be planted in this data. */
function plant(kind: FaultKind, db: SqlDb, plan: Plan, rand: () => number): Planted | { skip: string } {
  const ps = parts(db, plan).filter((p) => p.rows.length >= MIN_PART_ROWS);
  const dim = plan.dimension.replace(/_/g, " ");
  if (ps.length < 1) return { skip: `no ${dim} has enough rows in that period (${MIN_PART_ROWS}) to carry a fault` };
  const a = ps[0];
  const b = ps[1];
  const spread = detectorSpread(db, plan);
  if (kind === "segment_shift") {
    const what = shift(db, plan, a, rand, spread.of(a.value));
    return { what, expect: { findings_include: [{ dimension: plan.dimension, value: a.value }] } as Expectation };
  }
  if (kind === "data_gap") {
    const ids = a.rows.map((x) => x.rid);
    for (const c of chunks(ids)) db.run(`DELETE FROM ${q(plan.table)} WHERE rowid IN (${inList(c)})`);
    return { what: `all the rows of ${a.value} were removed, as if its data had not arrived (${ids.length} rows)`, expect: { stopped_reason: "data_quality" } as Expectation, accepts: (r) => ({ pass: r.status === "stopped" && DATA_STOPS.includes(r.stopped_reason ?? ""), detail: r.status === "stopped" ? `it declined, but for "${r.stopped_reason}", which is not about the data` : `it answered instead of declining (${r.findings.length} finding(s))` }) };
  }
  if (!b) return { skip: `a second ${dim} with enough rows is needed` };
  if (kind === "offsetting_pair") {
    const w = shift(db, plan, a, rand, spread.of(a.value));
    const g = shift(db, plan, b, rand, spread.of(b.value), true);
    return {
      what: `${a.value} was made worse (${w}) while ${b.value} was made better (${g})`,
      expect: { findings_include: [{ dimension: plan.dimension, value: a.value }], masking_flags: ["offsetting"] } as Expectation,
      // naming the worse part while the whole looks flat is the point; the analysis may call that an offsetting pair or a flat whole hiding a worse part
      accepts: (r) => {
        const named = r.findings.some((f) => f.dimension === plan.dimension && f.value === a.value);
        const flagged = r.masking_flags.some((f) => f.type === "offsetting" || f.type === "dispersion");
        return { pass: named && flagged, detail: `${named ? "it named " + a.value : "it did not name " + a.value}${flagged ? "" : " and raised no masking flag"}` };
      },
    };
  }
  // mix shift: only for a rate, and only between parts that differ: take the part with the best rate and the one with the worst
  if (plan.kind !== "ratio") return { skip: "moving rows between parts does not change a total" };
  const ranked = [...ps].sort((x, y) => mean(y.rows.map((r) => r.r)) - mean(x.rows.map((r) => r.r)));
  const hi = ranked[0];
  const lo = ranked[ranked.length - 1];
  const mh = mean(hi.rows.map((x) => x.r));
  const ml = mean(lo.rows.map((x) => x.r));
  if (hi === lo || Math.abs(mh - ml) < 0.05 * Math.max(Math.abs(mh), Math.abs(ml), 1e-9)) return { skip: `no two ${dim} have rates far enough apart for moving rows between them to change anything` };
  // move rows from the better part into the worse one, so the whole gets worse by mix alone
  const to = plan.higherIsBetter ? lo : hi;
  const others = ps.filter((p) => p !== to);
  // how much to move: enough to change the whole's rate by several standard errors, or nothing can be planted that the data could show
  const total = ps.reduce((a, p) => a + p.rows.length, 0);
  const rTo = mean(to.rows.map((x) => x.r));
  const perUnit = others.reduce((a, p) => a + p.rows.length * (mean(p.rows.map((x) => x.r)) - rTo), 0) / total;
  const overall = mean(ps.flatMap((p) => p.rows.map((x) => x.r)));
  // the whole's standard error as the headline judges it: counting noise plus the whole's own period-to-period spread
  const se = Math.sqrt((overall * (1 - overall)) / total + spread.whole * overall * (1 - overall)) * Math.sqrt(1 + 1 / baseline);
  const need = (plan.sigmas * se) / Math.abs(perUnit || 1e-9);
  if (!(Math.abs(perUnit) > 0) || need > MAX_MOVE) return { skip: `the ${dim} rates are too close for moving rows between them to change the whole by more than chance would (it would take moving ${Math.round(Math.min(need, 9.99) * 100)}% of every other part)` };
  const move = Math.min(MAX_MOVE, Math.max(MIN_SHARE, need));
  // a mix shift is new volume of the destination's kind in place of volume of the others': rows leave the others, and the same number of rows like the
  // destination's arrive (copies of its own), so no part's rate changes and only the weights do
  const leaving = others.flatMap((p) => pick(p.rows, move, rand).map((x) => x.rid));
  for (const c of chunks(leaving)) db.run(`DELETE FROM ${q(plan.table)} WHERE rowid IN (${inList(c)})`);
  const arriving: number[] = [];
  for (let i = 0; i < leaving.length; i++) arriving.push(to.rows[Math.floor(rand() * to.rows.length)].rid);
  for (const c of chunks(arriving)) for (const rid of c) db.run(`INSERT INTO ${q(plan.table)} SELECT * FROM ${q(plan.table)} WHERE rowid = ${rid}`);
  return {
    what: `${Math.round(move * 100)}% of the rows of every other ${dim} were replaced by rows like those of ${to.value} (${leaving.length} rows): no part got worse, only the mix changed`,
    expect: { findings_include: [{ dimension: plan.dimension, value: to.value }] } as Expectation,
  };
}

/** The fact the KPI counts over, and what is needed to plant faults in it. Throws, in words, when it cannot be done. */
function planFor(pack: PackDefinition, kpi: string, window: { start: string; end: string }, sigmas: number): Plan {
  const metric = pack.ontology.metrics[kpi];
  if (!metric) throw new Error(`"${kpi}" is not a KPI in this pack`);
  if (metric.type === "product") throw new Error(`${kpi} is a product of other KPIs; plant faults in its parts (${metric.drivers.join(", ")})`);
  const formula = pack.data.metrics[kpi];
  const fact = pack.data.facts[formula.fact];
  const dimension = pack.ontology.dimensions.find((d) => fact.concepts.includes(d));
  if (!dimension) throw new Error(`${kpi} has no flat dimension in its data to plant a fault in (its parts are only in hierarchies); this is not supported yet`);
  const numerator = "numerator" in formula ? formula.numerator : formula.value;
  return { fact: formula.fact, table: "__fact", time: fact.time, dimension, window, numerator, denominator: "numerator" in formula ? formula.denominator : "1", kind: metric.type === "ratio" ? "ratio" : "sum", higherIsBetter: metric.direction === "higher_is_better", sigmas };
}

export interface InjectOptions {
  workspace: string;
  kpi: string;
  seed?: number;
  /** How big to make each planted change, in standard errors of the part it is planted in (default 6). */
  sigmas?: number;
  corePlaybooksDir?: string;
  chunkMs?: number;
  /** Which kinds to plant (default all). */
  kinds?: FaultKind[];
}

export interface InjectReport {
  kpi: string;
  stage: "not_ready" | "running" | "done";
  reasons: string[];
  progress: { done: number; total: number };
  period?: { label: string; words: string };
  control?: { quiet: boolean; detail: string };
  outcomes: FaultOutcome[];
  level?: Level;
  /** Faults that could be planted, found out of planted. */
  summary?: { planted: number; found: number; not_applicable: number };
  /** Each size tried, largest first: the size asked for, then the smaller ones while everything was found. */
  sizes?: SizeTried[];
  /** The smallest size at which every fault that could be planted was found, with every larger size tried also found. */
  found_down_to?: number;
  /** The next size down, where at least one was missed (absent when nothing smaller was tried or nothing was missed). */
  missed_at?: number;
}

export interface SizeTried {
  sigmas: number;
  planted: number;
  found: number;
}


/**
 * Plant the faults and check the analysis. Works about 40 seconds at a time and keeps each result as it is known, so it resumes; with every kind
 * done, the result is kept on the KPI (the faults found, and out of how many) and may make the expert verified.
 */
export async function injectFaults(opts: InjectOptions): Promise<InjectReport> {
  const state = readState(opts.workspace);
  if (!state) throw new Error("this workspace has not been set up yet");
  const none = { progress: { done: 0, total: 0 }, outcomes: [] as FaultOutcome[] };
  if (state.dialect === "bigquery") return { kpi: opts.kpi, stage: "not_ready", reasons: ["Planting faults needs a copy of the data, and cloud data cannot be copied here yet. It works on files and local databases."], ...none };
  const quiet = quietPeriods(opts.workspace, opts.kpi);
  if (quiet.length === 0) return { kpi: opts.kpi, stage: "not_ready", reasons: [`${opts.kpi} has not been checked for false alarms yet, so there is no ordinary period to plant faults in. Run the false-alarm check first.`], ...none };
  const win = quiet[0];
  const pack = loadPack(opts.workspace, { requireMeta: true });
  const kinds = opts.kinds ?? FAULT_KINDS;
  const seed = opts.seed ?? 42;
  const sigmas = opts.sigmas ?? DEFAULT_SIGMAS;
  if (!(sigmas > 0)) throw new Error("the size of a planted change must be a positive number of standard errors");

  let file = readFile(opts.workspace, opts.kpi);
  const key = kpiKey(opts.workspace, opts.kpi, baseline);
  if (!file || file.key !== key || file.seed !== seed || (file.sigmas ?? DEFAULT_SIGMAS) !== sigmas || file.period !== win.period) {
    file = { version: 1, kpi: opts.kpi, key, seed, sigmas, period: win.period, start: win.start, end: win.end, outcomes: {} };
  }
  const plan = planFor(pack, opts.kpi, { start: win.start, end: win.end }, sigmas);
  const playbook = loadPlaybook("metric_change", opts.workspace, opts.corePlaybooksDir);
  const deadline = Date.now() + (opts.chunkMs ?? CHUNK_MS);
  // the full check at the default size goes on to smaller sizes; a run at a size or with kinds of the caller's choosing is that run alone
  const laddered = sigmas === DEFAULT_SIGMAS && opts.kinds === undefined;
  const smallerKinds = kinds.filter((k) => k !== "data_gap"); // missing data is declined whatever the size
  const allFound = (into: Record<string, FaultOutcome>, of: FaultKind[]) => {
    const planted = of.map((k) => into[k]).filter((o) => o?.applicable);
    return of.every((k) => into[k] !== undefined) && planted.length > 0 && planted.every((o) => o.pass);
  };
  /** The next fault to plant: the size asked for first, then each smaller size while everything at the size before it was found. */
  const next = (): { size: number; into: Record<string, FaultOutcome>; kind: FaultKind } | undefined => {
    for (const k of kinds) if (file!.outcomes[k] === undefined) return { size: sigmas, into: file!.outcomes, kind: k };
    if (!laddered || file!.control?.quiet !== true || !allFound(file!.outcomes, kinds)) return undefined;
    for (const s of SMALLER_SIZES) {
      const into = ((file!.smaller ??= {})[String(s)] ??= {});
      for (const k of smallerKinds) if (into[k] === undefined) return { size: s, into, kind: k };
      if (!allFound(into, smallerKinds)) return undefined;
    }
    return undefined;
  };

  if (next() !== undefined || file.control === undefined) {
    // a scratch copy of the whole project, with the KPI's fact written out as a table of its own: the faults change that table's rows, never the person's data
    const scratch = mkdtempSync(join(tmpdir(), "inject-"));
    try {
      cpSync(opts.workspace, scratch, { recursive: true, filter: (src) => !/[\\/](runs|agents|evals)([\\/]|$)/.test(src) && !/calibration-|faults-/.test(src) });
      const data = parseDocument(readFileSync(join(scratch, "data.yaml"), "utf-8"));
      const factSql = String(data.getIn(["facts", plan.fact, "sql"]));
      const db0 = await openDb(join(scratch, "data", "causeline.db"));
      db0.run(`DROP TABLE IF EXISTS ${q(plan.table)}`);
      db0.run(`CREATE TABLE ${q(plan.table)} AS ${factSql}`);
      saveDb(db0, join(scratch, "data", "causeline.db"));
      db0.close();
      data.setIn(["facts", plan.fact, "sql"], `SELECT * FROM ${q(plan.table)}`);
      writeFileSync(join(scratch, "data.yaml"), data.toString({ lineWidth: 0 }), "utf-8");
      generateForPack(scratch);

      const run = async (dir: string, planted: { expect: Expectation; accepts?: Planted["accepts"] }) => {
        const def = loadPack(dir, { requireMeta: true });
        const result = await runPlaybook({ playbook, ontology: def.ontology, meta: def.meta!, tools: new SqliteToolCaller(dir), inputs: { metric: opts.kpi, period: win.period, baseline } });
        const own = planted.accepts?.(result);
        const score = scoreRunner(result, planted.expect);
        const said = result.headline ? `the headline moved by ${result.headline.z !== undefined ? result.headline.z.toFixed(1) : "?"} standard errors (${result.headline.significant ? "significant" : "not significant"})` : `it declined (${result.stopped_reason})`;
        return { result, pass: own ? own.pass : score.pass, detail: `${own ? own.detail : score.checks.filter((c) => !c.ok).map((c) => c.detail ?? c.name).join("; ")}; ${said}` };
      };

      if (file.control === undefined) {
        // the same window, nothing planted: it must stay quiet or the faults prove nothing
        const { result } = await run(scratch, { expect: { no_findings: true } as Expectation });
        const calm = result.status === "complete" && result.findings.length === 0 && !result.headline?.significant;
        file.control = { quiet: calm, detail: calm ? "nothing raised" : result.status !== "complete" ? `the analysis declined (${result.stopped_reason})` : `${result.findings.length} finding(s)${result.headline?.significant ? " and a significant headline" : ""}` };
        writeFile(opts.workspace, file);
      }

      for (let job = next(); job !== undefined; job = next()) {
        if (Date.now() >= deadline && Object.keys(file.outcomes).length > 0) break;
        const { kind, into } = job;
        const sized = { ...plan, sigmas: job.size };
        const dir = mkdtempSync(join(tmpdir(), "inject-fault-"));
        try {
          cpSync(scratch, dir, { recursive: true });
          const dbPath = join(dir, "data", "causeline.db");
          const db = await openDb(dbPath);
          const rand = seeded(seed + FAULT_KINDS.indexOf(kind) * 1009);
          let planted: Planted | { skip: string };
          try {
            planted = plant(kind, db, sized, rand);
          } catch (e) {
            planted = { skip: (e as Error).message };
          }
          if ("skip" in planted) {
            db.close();
            into[kind] = { id: kind, kind, applicable: false, what: planted.skip, pass: false, at: new Date().toISOString() };
          } else {
            saveDb(db, dbPath);
            db.close();
            const { pass, detail } = await run(dir, planted);
            into[kind] = { id: kind, kind, applicable: true, what: planted.what, pass, ...(pass ? {} : { detail }), at: new Date().toISOString() };
          }
          writeFile(opts.workspace, file);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  writeFile(opts.workspace, file);

  const outcomes = kinds.map((k) => file!.outcomes[k]).filter((o): o is FaultOutcome => !!o);
  const smallerDone = Object.values(file.smaller ?? {}).reduce((a, o) => a + Object.keys(o).length, 0);
  const periodInfo = { label: win.period, words: `${win.start} to ${win.end}` };
  if (next() !== undefined) {
    // the smaller sizes are counted only once they are known to be coming (everything at the size asked for was found)
    const total = kinds.length + (outcomes.length === kinds.length ? smallerKinds.length * SMALLER_SIZES.length : 0);
    return { kpi: opts.kpi, stage: "running", reasons: [], progress: { done: outcomes.length + smallerDone, total }, period: periodInfo, control: file.control, outcomes };
  }
  const progress = { done: outcomes.length + smallerDone, total: outcomes.length + smallerDone };

  const planted = outcomes.filter((o) => o.applicable);
  const found = planted.filter((o) => o.pass);
  // how small a planted change was still found: each size tried, largest first, and where the finding stopped
  const sizes: SizeTried[] = [{ sigmas, planted: planted.length, found: found.length }];
  for (const s of SMALLER_SIZES) {
    const into = file.smaller?.[String(s)];
    if (!into) break;
    const p = smallerKinds.map((k) => into[k]).filter((o) => o?.applicable);
    sizes.push({ sigmas: s, planted: p.length, found: p.filter((o) => o.pass).length });
  }
  const whole = (t: SizeTried) => t.planted > 0 && t.found === t.planted;
  const foundDownTo = file.control?.quiet === true && whole(sizes[0]) ? sizes.filter((t, i) => sizes.slice(0, i + 1).every(whole)).at(-1)!.sigmas : undefined;
  const missedAt = foundDownTo === undefined ? undefined : sizes.find((t) => t.sigmas < foundDownTo && t.planted > 0 && !whole(t))?.sigmas;
  let level: Level = levelOf(state.kpis[opts.kpi]);
  updateState(opts.workspace, (s) => {
    const k = s.kpis[opts.kpi];
    const before = levelOf(k);
    const v = k.verification ?? { at: "", pass: false, incidents_passed: [] };
    const incidents = s.incidents.filter((i) => i.kpi === opts.kpi);
    const incidentsFound = incidents.every((i) => v.incidents_passed.includes(i.id));
    // faults made bigger than the default size are an easier test than the rung asks for, so they do not count toward it
    const clear = planted.length > 0 && found.length === planted.length && file!.control?.quiet === true && sigmas <= DEFAULT_SIGMAS;
    const { faults_found_down_to: _a, faults_missed_at: _b, ...kept } = v;
    k.verification = { ...kept, at: new Date().toISOString(), faults_passed: found.map((o) => o.id), faults_total: planted.length, faults_sigmas: sigmas, ...(foundDownTo !== undefined ? { faults_found_down_to: foundDownTo } : {}), ...(missedAt !== undefined ? { faults_missed_at: missedAt } : {}), pass: clear && incidentsFound };
    k.level = levelOf(k);
    level = k.level;
    logChange(s, `kpi:${opts.kpi}`, before, level, clear ? `${found.length} of ${planted.length} faults planted in the data's own quiet period were found` : `${found.length} of ${planted.length} planted faults were found`, "inject_faults");
  });
  if (level !== levelOf(state.kpis[opts.kpi])) syncExperts(opts.workspace, opts.kpi, level, `planted faults ${found.length === planted.length ? "were all found" : "were not all found"}`, "inject_faults");
  return { kpi: opts.kpi, stage: "done", reasons: [], progress, period: periodInfo, control: file.control, outcomes, level, summary: { planted: planted.length, found: found.length, not_applicable: outcomes.length - planted.length }, sizes, ...(foundDownTo !== undefined ? { found_down_to: foundDownTo } : {}), ...(missedAt !== undefined ? { missed_at: missedAt } : {}) };
}

export function faultStatus(workspace: string, kpi: string): { run: boolean; outcomes: FaultOutcome[]; control?: FaultsFile["control"]; seed?: number } {
  const f = readFile(workspace, kpi);
  return f ? { run: true, outcomes: Object.values(f.outcomes), control: f.control, seed: f.seed } : { run: false, outcomes: [] };
}

// the module-level helpers are exported for the tests
export { parts as _parts, plant as _plant };
export type { PeriodOutcome };
