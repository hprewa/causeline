import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { runDataChecks } from "@causeline/onboard";
import { completeBuckets } from "@causeline/router";
import { ScopedToolCaller, ToolIndex, toBuckets, type Bucket, type ToolCaller } from "@causeline/runner";
import { loadAgents, loadPack, type PackDefinition } from "@causeline/schema";
import { openDb, rowsOf, q } from "./db.js";
import { levelGap, levelOf, readState, updateState, type AutoResult, type CheckKind, type KpiRecord, type Level, type SignoffCheck } from "./state.js";

const STEP = "signoff";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A person says 93.1 and means 93.1%; a fraction is stored as 0.931. */
export function normaliseExpected(expected: number, isRate: boolean, observed: number): number {
  return isRate && observed > 0 && observed <= 1 && expected > 1 && expected <= 100 ? Math.round(expected * 1e7) / 1e9 : expected;
}

/** "9–15 March 2026", "15 March 2026" or "28 February – 6 March 2026". */
export function dayWords(start: string, end: string): string {
  const [a, b] = [start, end].map((d) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) - 1, d: Number(d.slice(8, 10)) }));
  if (start === end) return `${a.d} ${MONTHS[a.m]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m]} ${a.y}`;
  return a.y === b.y ? `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]} ${a.y}` : `${a.d} ${MONTHS[a.m]} ${a.y} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
}

const scopeWords = (scope: Record<string, string>) => (Object.keys(scope).length === 0 ? "the whole business" : Object.entries(scope).map(([c, v]) => `${c.replace(/_/g, " ")} ${v}`).join(", "));
const labelFor = (kind: CheckKind, scope: Record<string, string>, w: { start: string; end: string }, name?: string) => {
  const who = scopeWords(scope);
  const text = `${who[0].toUpperCase()}${who.slice(1)}, ${kind === "grain" ? "on " : ""}${dayWords(w.start, w.end)}`;
  return name ? `${text} (${name})` : text;
};

// --- numbers from the generated tools ------------------------------------------------------------

interface Ctx {
  workspace: string;
  pack: PackDefinition;
  index: ToolIndex;
  tools: ToolCaller;
  kpi: string;
  isRate: boolean;
  top: string;
  /** The finest level that stays inside a day, when there is one. */
  fine?: string;
  extent: { start: string; end: string; rows: number };
  cache: Map<string, Bucket[]>;
}

const dayOf = (b: Bucket, which: "bucket_start" | "bucket_end" = "bucket_start") => b[which].slice(0, 10);
const sumOf = (bs: Bucket[]) => bs.reduce((a, b) => ({ num: a.num + b.num, den: a.den + b.den }), { num: 0, den: 0 });

async function open(workspace: string, kpi: string, tools: ToolCaller): Promise<Ctx> {
  const pack = loadPack(workspace, { requireMeta: true });
  const def = pack.ontology.metrics[kpi];
  if (!def) throw new Error(`"${kpi}" is not a KPI in this pack (have: ${Object.keys(pack.ontology.metrics).join(", ")})`);
  if (def.type === "product") throw new Error(`${kpi} is a product of other KPIs; check its parts (${def.drivers.join(", ")})`);
  const index = new ToolIndex(pack.meta!);
  const counts = (await tools.call(index.extent(kpi), {}, STEP))[0];
  const levels = pack.ontology.time.levels;
  return {
    workspace,
    pack,
    index,
    tools,
    kpi,
    isRate: def.type === "ratio",
    top: levels[0],
    fine: levels.includes("day") ? "day" : levels[1],
    extent: { start: String(counts.min_ts), end: String(counts.max_ts), rows: Number(counts.n_rows) },
    cache: new Map(),
  };
}

async function series(ctx: Ctx, scope: Record<string, string>, level: string): Promise<Bucket[]> {
  const key = `${level}|${JSON.stringify(scope)}`;
  let hit = ctx.cache.get(key);
  if (!hit) {
    const caller = new ScopedToolCaller(ctx.tools, ctx.pack.meta!, scope);
    hit = toBuckets(await caller.call(ctx.index.series(ctx.kpi, level), { start: ctx.extent.start, end: ctx.extent.end }, STEP));
    ctx.cache.set(key, hit);
  }
  return hit;
}

/** The KPI over whole days, confined to a scope: summed from the day-level buckets (or the top level when there is no finer one). */
async function windowValue(ctx: Ctx, scope: Record<string, string>, w: { start: string; end: string }): Promise<{ value: number; num: number; den: number }> {
  const level = ctx.fine ?? ctx.top;
  const inside = (await series(ctx, scope, level)).filter((b) => dayOf(b) >= w.start && dayOf(b, "bucket_end") <= w.end);
  const { num, den } = sumOf(inside);
  return { num, den, value: ctx.isRate ? (den > 0 ? num / den : NaN) : num };
}

const within = (got: number, expected: number, tolerance: number) => Number.isFinite(got) && (expected === 0 ? Math.abs(got) <= 1e-9 : Math.abs(got - expected) <= tolerance * Math.abs(expected));

// --- proposing checks ----------------------------------------------------------------------------

export interface Proposal {
  id: string;
  kind: CheckKind;
  label: string;
  /** The question to put to the person. The number the tools give is not part of it. */
  ask: string;
}

export interface ProposeResult {
  kpi: string;
  proposals: Proposal[];
  level: Level;
  next: string;
}

/**
 * The numbers worth setting against another report, chosen by rule: the whole data over the last complete period;
 * the biggest part of the first hierarchy and of one flat concept over the same period; one day (a different grain,
 * which catches a week that starts on another day and a date taken from the wrong column); and, when the person
 * names it, a period they know was odd. The tools' numbers are worked out and stored, but not handed out: they are
 * shown only after the person has given theirs, so theirs is not shaped by ours.
 */
export async function proposeChecks(opts: { workspace: string; kpi: string; tools: ToolCaller; odd?: { start: string; end: string; name?: string } }): Promise<ProposeResult> {
  const ctx = await open(opts.workspace, opts.kpi, opts.tools);
  const periods = await completeBuckets(opts.tools, ctx.index, opts.kpi, ctx.top);
  const last = periods[periods.length - 1];
  if (!last) throw new Error(`${opts.kpi} has no complete period of data to check`);
  const window = { start: dayOf(last), end: dayOf(last, "bucket_end") };
  const candidates: { kind: CheckKind; scope: Record<string, string>; window: { start: string; end: string }; name?: string }[] = [{ kind: "total", scope: {}, window }];

  // the biggest part of the first hierarchy, and of one flat concept
  const ont = ctx.pack.ontology;
  const concepts = [Object.values(ont.hierarchies)[0]?.[0], ont.dimensions[0]].filter((c): c is string => !!c);
  const days = ctx.fine ? (await series(ctx, {}, ctx.fine)).filter((b) => dayOf(b) >= window.start && dayOf(b, "bucket_end") <= window.end) : [];
  for (const concept of concepts) {
    try {
      const params = days.length > 0 ? { cur_start: days[0].bucket_start, cur_end: days[days.length - 1].bucket_end, base_start: days[0].bucket_start, base_end: days[days.length - 1].bucket_end } : { cur_start: last.bucket_start, cur_end: last.bucket_end, base_start: last.bucket_start, base_end: last.bucket_end };
      const rows = await opts.tools.call(ctx.index.slice(opts.kpi, concept), params, STEP);
      const volume = (r: Record<string, unknown>) => Number(ctx.isRate ? r.cur_den : r.cur_num);
      const biggest = rows.filter((r) => r.node !== null && String(r.node) !== "" && String(r.node) !== "null").sort((a, b) => volume(b) - volume(a))[0];
      if (biggest) candidates.push({ kind: "slice", scope: { [concept]: String(biggest.node) }, window });
    } catch {
      // no tool splits the KPI by this concept: nothing to propose for it
    }
  }
  // one day: the last one with data, so the number is checked at a different grain from the period
  const lastDay = [...days].reverse().find((b) => b.den > 0 || b.num > 0);
  if (lastDay && window.start !== window.end) candidates.push({ kind: "grain", scope: {}, window: { start: dayOf(lastDay), end: dayOf(lastDay, "bucket_end") } });
  if (opts.odd) candidates.push({ kind: "odd_period", scope: {}, window: { start: opts.odd.start, end: opts.odd.end }, name: opts.odd.name });

  const proposals: Proposal[] = [];
  const existing = readState(opts.workspace)?.kpis[opts.kpi]?.checks ?? [];
  const fresh: SignoffCheck[] = [];
  const taken = new Set(existing.map((c) => c.id));
  for (const c of candidates) {
    if (existing.some((e) => e.kind === c.kind && JSON.stringify(e.scope) === JSON.stringify(c.scope) && e.window.start === c.window.start && e.window.end === c.window.end && (e.state !== "pending" || e.expected !== undefined))) continue;
    const got = await windowValue(ctx, c.scope, c.window);
    if (!Number.isFinite(got.value)) continue;
    let n = 1;
    while (taken.has(`${c.kind}-${n}`)) n++;
    const id = `${c.kind}-${n}`;
    taken.add(id);
    const label = labelFor(c.kind, c.scope, c.window, c.name);
    fresh.push({ id, kind: c.kind, scope: c.scope, window: c.window, label, got: got.value, tolerance: 0.01, state: "pending" });
    proposals.push({ id, kind: c.kind, label, ask: `What does your own report say for ${label}? (the number, and which report it is from)` });
  }
  const state = updateState(opts.workspace, (s) => {
    const rec = (s.kpis[opts.kpi] ??= { level: "draft", checks: [] });
    // earlier proposals nobody has answered are replaced, never piled up
    rec.checks = [...rec.checks.filter((c) => c.state !== "pending" || c.expected !== undefined), ...fresh];
  });
  const rec = state.kpis[opts.kpi];
  return { kpi: opts.kpi, proposals, level: levelOf(rec), next: proposals.length > 0 ? "Ask the user for these numbers from their own reports, from different angles, and record each with confirm_number." : "Everything proposed is already checked; see signoff_status." };
}

// --- the user's number ---------------------------------------------------------------------------

export interface Reveal {
  kpi: string;
  check: string;
  label: string;
  /** The person's number (a percentage said as 93.1 is read as 0.931 for a rate). */
  expected: number;
  /** The number the tools give, shown now that theirs is in. */
  got: number;
  /** Relative difference, tools against the person. */
  difference: number;
  match: boolean;
  hints: string[];
  state: SignoffCheck["state"];
  level: Level;
}

function hintsFor(kind: CheckKind, timeColumn: string, difference: number): string[] {
  const out = [`the tools give a number ${Math.abs(Math.round(difference * 1000) / 10)}% ${difference > 0 ? "above" : "below"} yours`];
  out.push(`check which date decides the period: this uses ${timeColumn}, and whether your report counts weeks from the same day`);
  if (kind === "grain") out.push("a single day depends on where midnight falls for your report and on which date a record is filed under");
  out.push("check what is counted: a filter your report applies (cancelled, test or duplicate records), and whether a join drops or repeats rows");
  return out;
}

function find(rec: KpiRecord | undefined, kpi: string, id: string): SignoffCheck {
  const c = rec?.checks.find((x) => x.id === id);
  if (!c) throw new Error(`there is no check "${id}" for ${kpi}${rec?.checks.length ? ` (have: ${rec.checks.map((x) => x.id).join(", ")})` : "; propose some first"}`);
  return c;
}

/**
 * Set the person's number against the tools' for one check. It does not confirm anything: the tools' number is
 * returned (it is revealed only now), and the check stays pending until it is confirmed or flagged.
 */
export async function recordNumber(opts: { workspace: string; kpi: string; check: string; expected: number; source: string; tolerance?: number; tools: ToolCaller }): Promise<Reveal> {
  if (!Number.isFinite(opts.expected)) throw new Error("the number must be a number");
  if (!opts.source.trim()) throw new Error("say where the number comes from (which report or system)");
  const state = readState(opts.workspace);
  const target = find(state?.kpis[opts.kpi], opts.kpi, opts.check);
  if (target.state === "confirmed") throw new Error(`${target.label} is already confirmed`);
  const ctx = await open(opts.workspace, opts.kpi, opts.tools);
  const now = target.window.start === "" ? { value: target.got } : await windowValue(ctx, target.scope, target.window);
  const expected = normaliseExpected(opts.expected, ctx.isRate, now.value);
  const tolerance = opts.tolerance ?? target.tolerance;
  const match = within(now.value, expected, tolerance);
  const difference = expected === 0 ? (now.value === 0 ? 0 : Infinity) : (now.value - expected) / Math.abs(expected);
  const after = updateState(opts.workspace, (s) => {
    const c = find(s.kpis[opts.kpi], opts.kpi, opts.check);
    Object.assign(c, { got: now.value, expected, source: opts.source.trim(), tolerance, state: "pending" as const, note: undefined });
  });
  return {
    kpi: opts.kpi,
    check: opts.check,
    label: target.label,
    expected,
    got: now.value,
    difference,
    match,
    hints: match ? [] : hintsFor(target.kind, ctx.pack.data.facts[ctx.pack.data.metrics[opts.kpi].fact].time, difference),
    state: "pending",
    level: levelOf(after.kpis[opts.kpi]),
  };
}

export interface Decision {
  kpi: string;
  check: string;
  state: SignoffCheck["state"];
  level: Level;
  /** What stands between the KPI and the next step up. */
  gap: string;
}

/** Make the ladder's level agree with what is stored, and take a verified expert back to draft when its KPI is no longer verified. */
function settle(workspace: string, kpi: string, change: (rec: KpiRecord) => void): { before: Level; after: Level; rec: KpiRecord } {
  let before = "draft" as Level;
  let out: KpiRecord | undefined;
  updateState(workspace, (s) => {
    const rec = (s.kpis[kpi] ??= { level: "draft", checks: [] });
    before = levelOf(rec);
    change(rec);
    rec.level = levelOf(rec);
    out = rec;
  });
  const after = levelOf(out);
  if (before === "verified" && after !== "verified") demoteExperts(workspace, kpi);
  return { before, after, rec: out! };
}

/** An expert is only ever verified on a verified KPI: when the KPI falls, its experts become drafts again. */
export function demoteExperts(workspace: string, kpi: string): string[] {
  const names: string[] = [];
  for (const a of loadAgents(workspace)) {
    if (a.kpi !== kpi || a.status !== "verified") continue;
    mkdirSync(join(workspace, "agents"), { recursive: true });
    writeFileSync(join(workspace, "agents", `${a.name}.yaml`), stringify({ ...a, status: "draft" }, { lineWidth: 0 }), "utf-8");
    names.push(a.name);
  }
  return names;
}

/** Confirm or flag a number the person has given. Confirming needs their number to match the tools' within the tolerance. */
export async function decide(opts: { workspace: string; kpi: string; check: string; decision: "confirm" | "flag"; note?: string; tools: ToolCaller }): Promise<Decision> {
  const target = find(readState(opts.workspace)?.kpis[opts.kpi], opts.kpi, opts.check);
  if (opts.decision === "confirm") {
    if (target.expected === undefined) throw new Error("give your own number first, then confirm");
    if (!within(target.got, target.expected, target.tolerance)) throw new Error(`the numbers do not match (yours ${target.expected}, the tools' ${target.got}); flag it, or correct your number`);
  }
  await refreshAuto(opts.workspace, opts.kpi, opts.tools, false);
  const { rec } = settle(opts.workspace, opts.kpi, (r) => {
    const c = find(r, opts.kpi, opts.check);
    c.state = opts.decision === "confirm" ? "confirmed" : "flagged";
    c.confirmed_at = new Date().toISOString();
    if (opts.note) c.note = opts.note;
  });
  return { kpi: opts.kpi, check: opts.check, state: rec.checks.find((c) => c.id === opts.check)!.state, level: levelOf(rec), gap: levelGap(rec) };
}

/** The chat path: give a number and, when it matches, confirm it in the same step (the person gave it; they are the confirmation). */
export async function confirmNumber(opts: { workspace: string; kpi: string; check: string; expected: number; source: string; tolerance?: number; tools: ToolCaller }): Promise<Reveal & { confirmed: boolean; gap: string }> {
  const reveal = await recordNumber(opts);
  if (!reveal.match) return { ...reveal, confirmed: false, gap: levelGap(readState(opts.workspace)?.kpis[opts.kpi]) };
  const d = await decide({ workspace: opts.workspace, kpi: opts.kpi, check: opts.check, decision: "confirm", tools: opts.tools });
  return { ...reveal, state: d.state, level: d.level, confirmed: true, gap: d.gap };
}

/** Add a number that has already matched (the one-number path) as a confirmed check, replacing the same check if there is one. */
export async function adoptConfirmed(opts: { workspace: string; kpi: string; kind: CheckKind; scope?: Record<string, string>; window: { start: string; end: string }; expected: number; got: number; tolerance: number; source: string; tools: ToolCaller }): Promise<Decision> {
  const scope = opts.scope ?? {};
  await refreshAuto(opts.workspace, opts.kpi, opts.tools, false);
  const { rec } = settle(opts.workspace, opts.kpi, (r) => {
    r.checks = r.checks.filter((c) => !(c.kind === opts.kind && JSON.stringify(c.scope) === JSON.stringify(scope) && c.window.start === opts.window.start && c.window.end === opts.window.end));
    let n = 1;
    while (r.checks.some((c) => c.id === `${opts.kind}-${n}`)) n++;
    r.checks.push({ id: `${opts.kind}-${n}`, kind: opts.kind, scope, window: opts.window, label: labelFor(opts.kind, scope, opts.window), got: opts.got, expected: opts.expected, source: opts.source, tolerance: opts.tolerance, state: "confirmed", confirmed_at: new Date().toISOString() });
  });
  return { kpi: opts.kpi, check: rec.checks[rec.checks.length - 1].id, state: "confirmed", level: levelOf(rec), gap: levelGap(rec) };
}

// --- automatic checks ----------------------------------------------------------------------------

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** How many distinct values a source table's column holds, from the connected data. */
async function distinctCount(workspace: string, table: string, column: string): Promise<number | null> {
  const file = join(workspace, "data", "causeline.db");
  if (!existsSync(file)) return null;
  const db = await openDb(file);
  try {
    return Number(Object.values(rowsOf(db, `SELECT COUNT(DISTINCT ${q(column)}) AS n FROM ${q(table)}`)[0])[0]);
  } finally {
    db.close();
  }
}

/**
 * What can be decided without the person: that parts add up to their whole (every split of the KPI gives the same
 * total as the whole data, and days add up to the top level), that no join multiplied the rows, and that the shape
 * and ranges of the data are sane. A failure here keeps a KPI from `verified` however well its numbers match.
 */
export async function autoChecks(opts: { workspace: string; kpi: string; tools: ToolCaller; ctx?: Ctx }): Promise<AutoResult[]> {
  const ctx = opts.ctx ?? (await open(opts.workspace, opts.kpi, opts.tools));
  const out: AutoResult[] = [];
  const top = sumOf(await series(ctx, {}, ctx.top));

  if (ctx.fine) {
    const fine = sumOf(await series(ctx, {}, ctx.fine));
    const ok = same(fine.num, top.num) && (!ctx.isRate || same(fine.den, top.den));
    out.push({ id: `days_add_up:${ctx.fine}`, ok, detail: ok ? `the ${ctx.fine}s add up to the ${ctx.top}s` : `the ${ctx.fine}s add up to ${fine.num} but the ${ctx.top}s to ${top.num}: some rows fall into a ${ctx.top} and not a ${ctx.fine}, or the other way round` });
  }

  const ont = ctx.pack.ontology;
  const concepts = [...Object.values(ont.hierarchies).flat(), ...ont.dimensions];
  for (const concept of concepts) {
    let slice;
    try {
      slice = ctx.index.slice(ctx.kpi, concept);
    } catch {
      continue; // no tool splits this KPI by the concept
    }
    const rows = await ctx.tools.call(slice, { cur_start: ctx.extent.start, cur_end: ctx.extent.end, base_start: ctx.extent.start, base_end: ctx.extent.end }, STEP);
    const parts = rows.reduce<{ num: number; den: number }>((a, r) => ({ num: a.num + Number(r.cur_num ?? 0), den: a.den + Number(r.cur_den ?? 0) }), { num: 0, den: 0 });
    const ok = same(parts.num, top.num) && (!ctx.isRate || same(parts.den, top.den));
    out.push({ id: `parts_add_up:${concept}`, ok, detail: ok ? `the ${concept} values add up to the whole` : `the ${concept} values add up to ${parts.num} but the whole is ${top.num}: some rows have no ${concept} or fall outside every value` });
  }

  const fact = ctx.pack.data.facts[ctx.pack.data.metrics[ctx.kpi].fact];
  if (!fact.one_row_per) {
    out.push({ id: "no_repeated_rows", ok: true, skipped: true, detail: "not checked: the fact does not say what one row stands for (one_row_per)" });
  } else {
    const have = await distinctCount(ctx.workspace, fact.one_row_per.table, fact.one_row_per.column);
    if (have === null) out.push({ id: "no_repeated_rows", ok: true, skipped: true, detail: "not checked: the source table cannot be counted from here" });
    else out.push({ id: "no_repeated_rows", ok: ctx.extent.rows === have, detail: ctx.extent.rows === have ? `${have} rows, one per ${fact.one_row_per.column}` : `the fact has ${ctx.extent.rows} rows but ${fact.one_row_per.table} has ${have} different ${fact.one_row_per.column}: a join repeats or drops rows` });
  }

  // shape and ranges. Only what makes a number wrong is held against the KPI; the rest is reported as a note.
  const data = await runDataChecks({ ontology: ont, data: ctx.pack.data, tools: ctx.tools, index: ctx.index });
  const gates = (id: string) => id.startsWith("single_parent") || id.startsWith("time_column_complete") || id === `values:${ctx.kpi}`;
  for (const c of data.filter((x) => gates(x.id))) out.push({ id: c.id, ok: c.status !== "fail", detail: c.detail });
  const notes = data.filter((x) => !gates(x.id) && x.status !== "pass" && !x.id.startsWith("values:"));
  out.push({ id: "data_notes", ok: true, detail: notes.length === 0 ? "no gaps, thin days or empty columns to note" : `to note: ${notes.map((n) => n.detail).join("; ")}` });
  return out;
}

/** Run the automatic checks (again, when `force`) and store the outcome. */
export async function refreshAuto(workspace: string, kpi: string, tools: ToolCaller, force: boolean): Promise<AutoResult[]> {
  const current = readState(workspace)?.kpis[kpi]?.auto;
  if (current && !force) return current.results;
  const results = await autoChecks({ workspace, kpi, tools });
  settle(workspace, kpi, (rec) => {
    rec.auto = { at: new Date().toISOString(), pass: results.every((r) => r.ok), results };
  });
  return results;
}

// --- re-running what is stored -------------------------------------------------------------------

export interface RunChecksResult {
  kpi: string;
  before: Level;
  after: Level;
  restored: boolean;
  rechecked: { id: string; label: string; expected: number; got: number; match: boolean; note?: string }[];
  auto: AutoResult[];
  gap: string;
}

/**
 * Work out again every number that was confirmed, and the automatic checks. A number that no longer matches goes
 * back to pending (with the new figure beside it); only when all still match, and the automatic checks pass, does
 * a KPI that had fallen to provisional become verified again.
 */
export async function runChecks(opts: { workspace: string; kpi: string; tools: ToolCaller }): Promise<RunChecksResult> {
  const ctx = await open(opts.workspace, opts.kpi, opts.tools);
  const rec0 = readState(opts.workspace)?.kpis[opts.kpi];
  if (!rec0) throw new Error(`${opts.kpi} has no checks yet; propose some first`);
  const auto = await autoChecks({ workspace: opts.workspace, kpi: opts.kpi, tools: opts.tools, ctx });
  const results: RunChecksResult["rechecked"] = [];
  const now = new Map<string, number | null>();
  for (const c of rec0.checks.filter((x) => x.state === "confirmed")) now.set(c.id, c.window.start === "" ? null : (await windowValue(ctx, c.scope, c.window)).value);
  const { before, after, rec } = settle(opts.workspace, opts.kpi, (rec) => {
    rec.auto = { at: new Date().toISOString(), pass: auto.every((r) => r.ok), results: auto };
    for (const c of rec.checks.filter((x) => x.state === "confirmed")) {
      const got = now.get(c.id);
      if (got === null || got === undefined) {
        c.state = "pending";
        c.note = "cannot be worked out again (it was recorded without its dates); give the number again";
        results.push({ id: c.id, label: c.label, expected: c.expected ?? NaN, got: c.got, match: false, note: c.note });
      } else if (within(got, c.expected ?? NaN, c.tolerance)) {
        c.got = got;
        results.push({ id: c.id, label: c.label, expected: c.expected!, got, match: true });
      } else {
        c.state = "pending";
        c.note = `no longer matches: the tools now give ${got}, and you gave ${c.expected}`;
        c.got = got;
        results.push({ id: c.id, label: c.label, expected: c.expected!, got, match: false, note: c.note });
      }
    }
  });
  return { kpi: opts.kpi, before, after, restored: before !== "verified" && after === "verified", rechecked: results, auto, gap: levelGap(rec) };
}

// --- where things stand --------------------------------------------------------------------------

export interface SignoffKpi {
  kpi: string;
  level: Level;
  /** What stands between it and the next step up, in plain words. */
  gap: string;
  auto?: { at: string; pass: boolean; results: AutoResult[] };
  checks: { id: string; kind: CheckKind; label: string; state: SignoffCheck["state"]; expected?: number; source?: string; got?: number; note?: string }[];
}

/** The ladder for one KPI or all of them. A number the tools give is shown only for a check the person has already answered. */
export function signoffStatus(workspace: string, kpi?: string): SignoffKpi[] {
  const state = readState(workspace);
  if (!state) throw new Error("this workspace has not been set up yet");
  return Object.entries(state.kpis)
    .filter(([k]) => !kpi || k === kpi)
    .map(([k, rec]) => ({
      kpi: k,
      level: levelOf(rec),
      gap: levelGap(rec),
      ...(rec.auto ? { auto: rec.auto } : {}),
      checks: rec.checks.map((c) => ({ id: c.id, kind: c.kind, label: c.label, state: c.state, ...(c.expected !== undefined ? { expected: c.expected, source: c.source, got: c.got } : {}), ...(c.note ? { note: c.note } : {}) })),
    }));
}
