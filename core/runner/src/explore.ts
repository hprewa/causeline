import { conceptsOf, EXPLORATORY_SAYS, type Exploration, type ExploreStep, type Ontology, type Refusal } from "@causeline/schema";
import { DEFAULT_THRESHOLDS, resolveThresholds } from "./masking.js";
import { toBuckets, toChildRows } from "./rows.js";
import { rate, sum, zScore, zSum } from "./stats.js";
import type { ToolIndex } from "./toolindex.js";
import type { Bucket, Components, Row, ToolCaller } from "./types.js";

/**
 * The Explorer: questions no expert covers, answered from a closed set of read operations over the pack's own catalogue tools.
 *
 * - Nothing here takes SQL, a table, a column or an expression. A KPI, a concept, a time level and a cycle must be ones the ontology
 *   names; a filter value is passed to a tool as a bound value, never as text to run.
 * - Every operation returns rows and one plain sentence. The assistant quotes the rows and never computes from them.
 * - Every step is written to the exploration's record, which is always labelled exploratory.
 * - Two budgets, enforced here and not by the assistant: steps, and rows returned. Past either, the exploration ends with a stated reason.
 */

export const OPS = ["breakdown", "rank", "series", "compare", "profile", "cannot"] as const;
export type ExploreOp = (typeof OPS)[number];

export interface ExploreArgs {
  op: ExploreOp;
  kpi?: string;
  /** The concept to split by (breakdown, rank, compare of two values). */
  by?: string;
  /** Confine to these values of other concepts: `{concept: value}`. */
  filters?: Record<string, string>;
  /** The window: a period label of the top time level, or whole days (both inclusive). */
  period?: string;
  start_date?: string;
  end_date?: string;
  /** A second window to set the first against (the same ways). */
  against_period?: string;
  against_start?: string;
  against_end?: string;
  /** rank: which end, and by what. `biggest_rise` and `biggest_fall` need a second window. */
  order?: "highest" | "lowest" | "biggest_rise" | "biggest_fall";
  top?: number;
  /** series: the time level. */
  level?: string;
  /** profile: the cycle (for example a weekday). */
  cycle?: string;
  /** compare: the two values of `by` to set side by side. */
  nodes?: [string, string];
  /** cannot: what kind of request this is. */
  kind?: "free_sql" | "join" | "cause" | "change" | "unknown_kpi" | "other";
  /** cannot: the person's words, kept in the record. */
  request?: string;
}

export interface ExploreBudget {
  steps: number;
  rows: number;
}
export const DEFAULT_BUDGET: ExploreBudget = { steps: 12, rows: 400 };

export interface ExploreOptions {
  ontology: Ontology;
  index: ToolIndex;
  tools: ToolCaller;
  question?: string;
  budget?: Partial<ExploreBudget>;
  /** Where each KPI stands on the ladder, so the record can say how far the numbers read are trusted. */
  rungOf?: (kpi: string) => string;
  id?: string;
  now?: () => Date;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const round6 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const plain = (s: string) => s.replace(/_/g, " ");
const MAX_TOP = 25;
const MAX_LISTED = 10;

interface Win {
  start: string;
  end: string;
  /** How to say it. */
  label: string;
  days: number | null;
}

type Cell = string | number | boolean | null;
type OutRow = Record<string, Cell>;

/** A refusal, thrown inside an operation and turned into the step's answer. */
class Declined extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.reason);
  }
}
const decline = (code: Refusal["code"], reason: string, instead: string): never => {
  throw new Declined({ code, reason, instead });
};

const CANNOT: Record<NonNullable<ExploreArgs["kind"]>, Refusal> = {
  free_sql: { code: "free_sql", reason: "Free-form queries are not available: this can only read the KPIs and breakdowns your project defines, through fixed operations.", instead: "Ask for the KPI split by a concept it already has (for example a ranking or a breakdown), or add the figure you need as a KPI with the Builder." },
  join: { code: "join", reason: "Combining two sets of data that are not already joined in a KPI's definition is not something this can do.", instead: "Describe the combined figure as a KPI with the Builder, so it is defined, checked against your reports and then available here." },
  cause: { code: "cause", reason: "A reading of the data cannot say what caused a change; the root-cause analysis is the part that looks for where and when something moved.", instead: "Ask why the KPI changed in a period and the analysis will run, with its evidence." },
  change: { code: "change", reason: "This only reads; it cannot change data, definitions or settings.", instead: "Definitions are changed by describing them to the Builder, which asks you to confirm each one." },
  unknown_kpi: { code: "unknown_kpi", reason: "That figure is not one of the project's KPIs.", instead: "Say which of the project's KPIs you mean, or add it with the Builder." },
  other: { code: "other", reason: "This is outside what the fixed read operations can do.", instead: "Ask for a KPI split by a concept, a KPI over time, a comparison of two values or two periods, or its pattern over a cycle." },
};

/** What the standard refusals say, for the assistant's tool description and the tests. */
export const refusalKinds = (): string[] => Object.keys(CANNOT);

export class Explorer {
  readonly record: Exploration;
  private readonly th;
  private readonly cache = new Map<string, Bucket[]>();
  private readonly budget: ExploreBudget;

  constructor(private readonly o: ExploreOptions) {
    this.budget = { ...DEFAULT_BUDGET, ...o.budget };
    this.th = resolveThresholds(o.ontology.thresholds);
    this.record = {
      id: o.id ?? `${(o.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-")}`,
      question: o.question ?? "",
      started: (o.now?.() ?? new Date()).toISOString(),
      label: "exploratory",
      kpis: [],
      steps: [],
      budget: { steps: 0, max_steps: this.budget.steps, rows: 0, max_rows: this.budget.rows },
      stopped: null,
    };
  }

  /** Run one operation. Never throws for a request it cannot do: the answer is the step, with its refusal. */
  async run(args: ExploreArgs): Promise<ExploreStep> {
    const n = this.record.steps.length + 1;
    const started = Date.now();
    const before = this.o.tools.cost?.();
    const base: ExploreStep = { n, op: args.op, asked: this.askedOf(args), args: this.argsOf(args), says: "", columns: [], rows: [], rows_total: 0, notes: [], queries: 0, ms: 0 };
    let step: ExploreStep;
    if (this.record.stopped) {
      step = { ...base, refusal: { code: "budget", reason: this.record.stopped.detail, instead: "Start a new exploration, or ask the analysis a more specific question." }, says: this.record.stopped.detail };
    } else if (this.record.steps.filter((s) => !s.refusal).length >= this.budget.steps) {
      step = this.budgetStop(base, `This exploration has used its ${this.budget.steps} steps.`);
    } else if (this.record.budget.rows >= this.budget.rows) {
      step = this.budgetStop(base, `This exploration has returned its ${this.budget.rows} rows.`);
    } else {
      try {
        const out = await this.dispatch(args);
        const room = this.budget.rows - this.record.budget.rows;
        const kept = out.rows.slice(0, room);
        step = { ...base, ...out, rows: kept, notes: [...out.notes, ...(kept.length < out.rows.length ? [`Only ${kept.length} of ${out.rows.length} rows are shown: the exploration's row budget (${this.budget.rows}) ran out.`] : [])] };
      } catch (e) {
        if (!(e instanceof Declined)) throw e;
        step = { ...base, says: e.refusal.reason, refusal: e.refusal };
      }
    }
    const after = this.o.tools.cost?.();
    step.queries = before && after ? after.queries - before.queries : step.queries;
    if (before && after) step.bytes_scanned = Math.max(0, after.bytes_scanned - before.bytes_scanned);
    step.ms = Date.now() - started;
    this.record.steps.push(step);
    if (!step.refusal) {
      this.record.budget.steps += 1;
      this.record.budget.rows += step.rows.length;
    }
    if (args.kpi && this.o.ontology.metrics[args.kpi] && !this.record.kpis.some((k) => k.kpi === args.kpi)) this.record.kpis.push({ kpi: args.kpi, rung: this.o.rungOf?.(args.kpi) ?? "draft" });
    return step;
  }

  private budgetStop(base: ExploreStep, detail: string): ExploreStep {
    this.record.stopped = { reason: "budget", detail };
    return { ...base, says: detail, refusal: { code: "budget", reason: detail, instead: "Summarise what was found so far, or ask the analysis a more specific question." } };
  }

  // --- words ---------------------------------------------------------------------------------------------

  private askedOf(a: ExploreArgs): string {
    const kpi = a.kpi ? plain(a.kpi) : "";
    const win = a.period ?? (a.start_date ? `${a.start_date} to ${a.end_date ?? "?"}` : "");
    const inside = a.filters && Object.keys(a.filters).length ? ` inside ${Object.entries(a.filters).map(([k, v]) => `${plain(k)} ${v}`).join(", ")}` : "";
    switch (a.op) {
      case "breakdown":
        return `${kpi} by ${plain(a.by ?? "?")}${inside}${win ? `, ${win}` : ""}`;
      case "rank":
        return `${a.order ?? "highest"} ${a.top ?? 5} ${plain(a.by ?? "?")} by ${kpi}${inside}${win ? `, ${win}` : ""}`;
      case "series":
        return `${kpi} by ${plain(a.level ?? "?")}${inside}${win ? `, ${win}` : ""}`;
      case "compare":
        return a.nodes ? `${kpi}: ${a.nodes[0]} against ${a.nodes[1]} (${plain(a.by ?? "?")})${win ? `, ${win}` : ""}` : `${kpi}: ${win || "?"} against ${a.against_period ?? (a.against_start ? `${a.against_start} to ${a.against_end}` : "?")}`;
      case "profile":
        return `${kpi} by position in the ${plain(a.cycle ?? "?")} cycle${win ? `, ${win}` : ""}`;
      case "cannot":
        return `a request that cannot be carried out${a.request ? `: ${a.request}` : ""}`;
    }
  }

  private argsOf(a: ExploreArgs): Record<string, unknown> {
    return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== ""));
  }

  // --- checks --------------------------------------------------------------------------------------------

  private kpi(a: ExploreArgs): { name: string; kind: "ratio" | "sum"; minVolume: number } {
    const name = a.kpi ?? "";
    const def = this.o.ontology.metrics[name];
    if (!def) {
      const have = Object.keys(this.o.ontology.metrics).map(plain).join(", ");
      return decline("unknown_kpi", `"${name}" is not one of the project's KPIs.`, `The KPIs are: ${have}. Say which you mean, or add a new one with the Builder.`);
    }
    if (def.type === "product") return decline("unsupported", `${plain(name)} is a product of ${def.drivers.map(plain).join(" and ")}, so it has no breakdown of its own.`, `Read its parts (${def.drivers.map(plain).join(", ")}) instead, or ask why it changed.`);
    return { name, kind: def.type, minVolume: def.min_volume };
  }

  private concept(name: string | undefined, what: string): string {
    const have = conceptsOf(this.o.ontology);
    if (!name || !have.includes(name)) return decline("unknown_concept", `"${name ?? ""}" is not something the project can break ${what} down by.`, `The concepts are: ${have.map(plain).join(", ")}.`);
    return name;
  }

  private filters(a: ExploreArgs, by?: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.filters ?? {})) {
      this.concept(k, "or confine it");
      if (k === by) decline("unsupported", `"${plain(k)}" is both what the split is by and a filter.`, "Leave the filter out, or split by a different concept.");
      out[k] = String(v);
    }
    return out;
  }

  // --- windows -------------------------------------------------------------------------------------------

  private async cached(key: string, load: () => Promise<Bucket[]>): Promise<Bucket[]> {
    if (!this.cache.has(key)) this.cache.set(key, await load());
    return this.cache.get(key)!;
  }

  private async extent(kpi: string): Promise<{ start: string; end: string }> {
    const rows = await this.o.tools.call(this.o.index.extent(kpi), {}, "explore");
    return { start: String(rows[0]?.min_ts ?? ""), end: String(rows[0]?.max_ts ?? "") };
  }

  private dayLevel(): string {
    const levels = this.o.ontology.time.levels;
    return levels.includes("day") ? "day" : (levels[1] ?? levels[0]);
  }

  private async daySeries(kpi: string): Promise<Bucket[]> {
    return this.cached(`day:${kpi}`, async () => toBuckets(await this.o.tools.call(this.o.index.series(kpi, this.dayLevel()), await this.extent(kpi), "explore")));
  }

  private async topSeries(kpi: string): Promise<Bucket[]> {
    return this.cached(`top:${kpi}`, async () => toBuckets(await this.o.tools.call(this.o.index.series(kpi, this.o.ontology.time.levels[0]), await this.extent(kpi), "explore")));
  }

  /** A window from a period label of the top level, or from whole days, cut to the data's own timestamps. */
  private async window(kpi: string, w: { period?: string; start?: string; end?: string }, role: string): Promise<Win> {
    if (w.period) {
      const top = await this.topSeries(kpi);
      const hit = top.find((b) => b.bucket === w.period);
      if (!hit) return decline("unsupported", `${role} "${w.period}" is not a ${plain(this.o.ontology.time.levels[0])} in the data, which has ${top[0]?.bucket} to ${top[top.length - 1]?.bucket}.`, "Use one of those, or give whole days as start and end dates.");
      return { start: hit.bucket_start, end: hit.bucket_end, label: hit.bucket, days: null };
    }
    if (!w.start || !w.end || !ISO_DAY.test(w.start) || !ISO_DAY.test(w.end) || Number.isNaN(Date.parse(`${w.start}T00:00:00Z`)) || Number.isNaN(Date.parse(`${w.end}T00:00:00Z`))) {
      return decline("unsupported", `${role} needs a period, or both a start and an end date written YYYY-MM-DD.`, "Give the dates of the window you mean.");
    }
    if (w.end < w.start) return decline("unsupported", `${role} ends (${w.end}) before it starts (${w.start}).`, "Swap the dates.");
    const days = await this.daySeries(kpi);
    const inside = days.filter((b) => b.bucket_start.slice(0, 10) >= w.start! && b.bucket_start.slice(0, 10) <= w.end!);
    if (inside.length === 0) {
      const first = days[0]?.bucket_start.slice(0, 10);
      const last = days[days.length - 1]?.bucket_start.slice(0, 10);
      return decline("unsupported", `${w.start} to ${w.end} holds no data. The data covers ${first} to ${last}.`, "Choose a window inside that range.");
    }
    return { start: inside[0].bucket_start, end: inside[inside.length - 1].bucket_end, label: `${w.start} to ${w.end}`, days: dayNumber(w.end) - dayNumber(w.start) + 1 };
  }

  private async mainWindow(kpi: string, a: ExploreArgs): Promise<Win> {
    return this.window(kpi, { period: a.period, start: a.start_date, end: a.end_date }, "the window");
  }

  private async againstWindow(kpi: string, a: ExploreArgs): Promise<Win | null> {
    if (!a.against_period && !a.against_start && !a.against_end) return null;
    return this.window(kpi, { period: a.against_period, start: a.against_start, end: a.against_end }, "the window to set it against");
  }

  // --- the operations --------------------------------------------------------------------------------------

  private async dispatch(a: ExploreArgs): Promise<Pick<ExploreStep, "says" | "columns" | "rows" | "rows_total" | "notes">> {
    if (a.op === "cannot") {
      const r = CANNOT[a.kind ?? "other"] ?? CANNOT.other;
      throw new Declined(r);
    }
    const k = this.kpi(a);
    switch (a.op) {
      case "breakdown":
      case "rank":
        return this.split(a, k);
      case "series":
        return this.seriesOp(a, k);
      case "compare":
        return this.compare(a, k);
      case "profile":
        return this.profile(a, k);
    }
    return decline("unsupported", `"${String(a.op)}" is not an operation.`, `The operations are: ${OPS.filter((o) => o !== "cannot").join(", ")}.`);
  }

  private value(kind: "ratio" | "sum", c: Components): number | null {
    return kind === "sum" ? c.num : rate(c);
  }

  private async sliceRows(kpi: string, by: string, filters: Record<string, string>, cur: Win, base: Win) {
    let tool: string;
    try {
      tool = this.o.index.slice(kpi, by, Object.keys(filters));
    } catch {
      return decline("unsupported", `${plain(kpi)} cannot be split by ${plain(by)}${Object.keys(filters).length ? ` inside ${Object.keys(filters).map(plain).join(" and ")}` : ""}.`, "Try splitting by it without the filter, or filter by fewer concepts.");
    }
    const rows = await this.o.tools.call(tool, { cur_start: cur.start, cur_end: cur.end, base_start: base.start, base_end: base.end, ...filters }, "explore");
    return toChildRows(rows);
  }

  /** The values a concept can take, for when a filter value matched nothing: never a guess. */
  private async validValues(kpi: string, concept: string, win: Win): Promise<string[]> {
    try {
      const rows = toChildRows(await this.o.tools.call(this.o.index.slice(kpi, concept, []), { cur_start: win.start, cur_end: win.end, base_start: win.start, base_end: win.end }, "explore"));
      return rows.sort((x, y) => y.cur.den - x.cur.den).slice(0, 20).map((r) => r.node);
    } catch {
      return [];
    }
  }

  private async split(a: ExploreArgs, k: { name: string; kind: "ratio" | "sum"; minVolume: number }) {
    const by = this.concept(a.by, `${plain(k.name)}`);
    const filters = this.filters(a, by);
    const cur = await this.mainWindow(k.name, a);
    const against = await this.againstWindow(k.name, a);
    const order = a.op === "rank" ? (a.order ?? "highest") : null;
    if ((order === "biggest_rise" || order === "biggest_fall") && !against) {
      return decline("unsupported", `"${order.replace("_", " ")}" needs a second window to set the first against.`, "Give against_period, or against_start and against_end.");
    }
    const rows = await this.sliceRows(k.name, by, filters, cur, against ?? cur);
    const notes: string[] = [];
    if (against && cur.days !== null && against.days !== null && cur.days !== against.days && k.kind === "sum") notes.push("The two windows are not the same length, so changes in a total are not like for like.");
    if (rows.length === 0 || rows.every((r) => r.cur.den === 0)) {
      const values = Object.keys(filters).length ? (await Promise.all(Object.keys(filters).map(async (c) => `${plain(c)}: ${(await this.validValues(k.name, c, cur)).join(", ") || "none found"}`))).join("; ") : "";
      return { says: `Nothing matched${Object.keys(filters).length ? ` those filters in ${cur.label}` : ` in ${cur.label}`}.${values ? ` The values that exist are, ${values}.` : ""}`, columns: [], rows: [], rows_total: 0, notes };
    }
    const unit = (c: Components) => this.value(k.kind, c);
    const nodes = rows.map((r) => ({ node: r.node, cur: r.cur, base: r.base, value: unit(r.cur), change: against && unit(r.base) !== null && unit(r.cur) !== null ? (unit(r.cur) as number) - (unit(r.base) as number) : null }));
    const volume = sum(nodes.map((n) => n.cur)).den;
    const thin = nodes.filter((n) => n.cur.den < k.minVolume);
    const kept = nodes.filter((n) => n.cur.den >= k.minVolume || k.minVolume === 0);
    const columns = ["node", "value", "volume", "share_of_volume", ...(against ? ["value_before", "change"] : [])];
    const toRow = (n: (typeof nodes)[number]): OutRow => ({
      node: n.node,
      value: round6(n.value),
      volume: n.cur.den,
      share_of_volume: volume > 0 ? round6(n.cur.den / volume) : null,
      ...(against ? { value_before: round6(unit(n.base)), change: round6(n.change) } : {}),
    });
    if (a.op === "breakdown") {
      const sorted = [...kept, ...thin.filter((t) => k.minVolume === 0)].sort((x, y) => y.cur.den - x.cur.den || x.node.localeCompare(y.node));
      const shown = sorted.slice(0, MAX_TOP).map(toRow);
      const rest = sorted.slice(MAX_TOP);
      if (rest.length > 0) shown.push({ node: `(${rest.length} others)`, value: round6(unit(sum(rest.map((n) => n.cur)))), volume: sum(rest.map((n) => n.cur)).den, share_of_volume: volume > 0 ? round6(sum(rest.map((n) => n.cur)).den / volume) : null, ...(against ? { value_before: null, change: null } : {}) });
      if (thin.length > 0 && k.minVolume > 0) notes.push(`${thin.length} ${plain(by)} value${thin.length === 1 ? " has" : "s have"} under ${k.minVolume} rows and ${thin.length === 1 ? "is" : "are"} left out of the breakdown: ${thin.sort((x, y) => y.cur.den - x.cur.den).slice(0, MAX_LISTED).map((n) => `${n.node} (${n.cur.den})`).join(", ")}${thin.length > MAX_LISTED ? ", ..." : ""}.`);
      return { says: `${plain(k.name)} by ${plain(by)} in ${cur.label}: ${sorted.length} value${sorted.length === 1 ? "" : "s"}, ${volume} rows in all.`, columns, rows: shown, rows_total: sorted.length, notes };
    }
    // rank: by value, or by change against the other window; groups under the KPI's minimum volume are not ranked
    const key = (n: (typeof nodes)[number]) => (order === "highest" || order === "lowest" ? n.value : n.change);
    const rankable = kept.filter((n) => key(n) !== null);
    const desc = order === "highest" || order === "biggest_rise";
    rankable.sort((x, y) => (desc ? (key(y) as number) - (key(x) as number) : (key(x) as number) - (key(y) as number)) || x.node.localeCompare(y.node));
    const top = Math.max(1, Math.min(MAX_TOP, Math.floor(a.top ?? 5)));
    if (thin.length > 0 && k.minVolume > 0) notes.push(`${thin.length} ${plain(by)} value${thin.length === 1 ? "" : "s"} had under ${k.minVolume} rows and ${thin.length === 1 ? "was" : "were"} not ranked: ${thin.sort((x, y) => y.cur.den - x.cur.den).slice(0, MAX_LISTED).map((n) => `${n.node} (${n.cur.den})`).join(", ")}${thin.length > MAX_LISTED ? ", ..." : ""}.`);
    const out = rankable.slice(0, top).map((n, i) => ({ rank: i + 1, ...toRow(n) }));
    const words: Record<string, string> = { highest: "highest", lowest: "lowest", biggest_rise: "biggest rise", biggest_fall: "biggest fall" };
    return { says: `The ${out.length} ${plain(by)} value${out.length === 1 ? "" : "s"} with the ${words[order ?? "highest"]} ${plain(k.name)} in ${cur.label}${against ? `, against ${against.label}` : ""}, out of ${rankable.length} that could be ranked.`, columns: ["rank", ...columns], rows: out, rows_total: rankable.length, notes };
  }

  private async seriesOp(a: ExploreArgs, k: { name: string; kind: "ratio" | "sum" }) {
    const levels = this.o.ontology.time.levels;
    const level = a.level ?? levels[0];
    if (!levels.includes(level)) return decline("unsupported", `"${level}" is not a time level of this project.`, `The levels are: ${levels.join(", ")}.`);
    const filters = this.filters(a);
    const win = await this.mainWindow(k.name, a);
    let tool: string;
    try {
      tool = this.o.index.series(k.name, level, Object.keys(filters));
    } catch {
      return decline("unsupported", `${plain(k.name)} cannot be read by ${plain(level)}${Object.keys(filters).length ? ` inside ${Object.keys(filters).map(plain).join(" and ")}` : ""}.`, "Try without the filter, or at another time level.");
    }
    const buckets = toBuckets(await this.o.tools.call(tool, { start: win.start, end: win.end, ...filters }, "explore"));
    const rows: OutRow[] = buckets.map((b) => ({ bucket: b.bucket, from: b.bucket_start, to: b.bucket_end, value: round6(this.value(k.kind, b)), volume: b.den }));
    return { says: `${plain(k.name)} by ${plain(level)} in ${win.label}: ${rows.length} period${rows.length === 1 ? "" : "s"}.`, columns: ["bucket", "from", "to", "value", "volume"], rows, rows_total: rows.length, notes: [] };
  }

  private async compare(a: ExploreArgs, k: { name: string; kind: "ratio" | "sum" }) {
    const z = (x: Components, y: Components) => (k.kind === "sum" ? zSum(x, y, 1) : zScore(x, y));
    let sides: { label: string; c: Components }[];
    let kind: string;
    if (a.nodes) {
      const by = this.concept(a.by, `${plain(k.name)}`);
      const filters = this.filters(a, by);
      const win = await this.mainWindow(k.name, a);
      const rows = await this.sliceRows(k.name, by, filters, win, win);
      const find = (n: string) => rows.find((r) => r.node === n)?.cur;
      const [ca, cb] = [find(a.nodes[0]), find(a.nodes[1])];
      if (!ca || !cb) {
        const have = rows.sort((x, y) => y.cur.den - x.cur.den).slice(0, 20).map((r) => r.node).join(", ");
        return decline("unsupported", `${[!ca ? a.nodes[0] : "", !cb ? a.nodes[1] : ""].filter(Boolean).join(" and ")} not found among the ${plain(by)} values in ${win.label}.`, `The values include: ${have}.`);
      }
      sides = [{ label: a.nodes[0], c: ca }, { label: a.nodes[1], c: cb }];
      kind = `${plain(by)} values in ${win.label}`;
    } else {
      const w1 = await this.mainWindow(k.name, a);
      const w2 = await this.againstWindow(k.name, a);
      if (!w2) return decline("unsupported", "A comparison needs two values of a concept (nodes), or two windows (a window and against_...).", "Say what to set against what.");
      const totals = async (w: Win): Promise<Components> => {
        const days = await this.daySeries(k.name);
        return sum(days.filter((b) => b.bucket_start >= w.start && b.bucket_end <= w.end));
      };
      sides = [{ label: w1.label, c: await totals(w1) }, { label: w2.label, c: await totals(w2) }];
      kind = "two windows";
    }
    const [x, y] = [this.value(k.kind, sides[0].c), this.value(k.kind, sides[1].c)];
    if (x === null || y === null) return decline("unsupported", "One side of the comparison has no rows.", "Choose a window or value that has data.");
    const zz = z(sides[0].c, sides[1].c);
    const significant = Math.abs(zz) >= (this.th.parent_z ?? DEFAULT_THRESHOLDS.parent_z);
    const rows: OutRow[] = [
      { label: sides[0].label, value: round6(x), volume: sides[0].c.den },
      { label: sides[1].label, value: round6(y), volume: sides[1].c.den },
      { label: "difference", value: round6(x - y), volume: null },
    ];
    return { says: `${plain(k.name)}, ${kind}: ${sides[0].label} against ${sides[1].label}. The difference is ${significant ? "more than chance explains" : "within what chance explains"} (z = ${Number.isFinite(zz) ? zz.toFixed(1) : "very large"}).`, columns: ["label", "value", "volume"], rows: [...rows, { label: "z", value: Number.isFinite(zz) ? round6(zz) : null, volume: null }, { label: "more than chance explains", value: significant, volume: null }], rows_total: rows.length, notes: k.kind === "sum" ? ["For totals the two sides are compared as they are; windows of different length are not like for like."] : [] };
  }

  private async profile(a: ExploreArgs, k: { name: string; kind: "ratio" | "sum" }) {
    const available = Object.values(this.o.index.meta.tools).flatMap((m) => (m.kind === "seasonal_profile" && m.metric === k.name ? [m.cycle] : []));
    const cycle = a.cycle ?? "";
    if (!available.includes(cycle)) return decline("unsupported", `${plain(k.name)} has no pattern by "${cycle}".`, available.length ? `The cycles are: ${available.map(plain).join(", ")}.` : "No cycle is available for it.");
    const win = a.period || a.start_date ? await this.mainWindow(k.name, a) : { ...(await this.extent(k.name)), label: "all the data", days: null };
    const rows = await this.o.tools.call(this.o.index.profile(k.name, cycle), { start: win.start, end: win.end }, "explore");
    const out: OutRow[] = rows.map((r: Row) => {
      const c = { num: Number(r.num ?? 0), den: Number(r.den ?? 0) };
      const instances = Number(r.instances ?? 0);
      return { position: String(r.slot ?? ""), value: round6(k.kind === "sum" ? (instances > 0 ? c.num / instances : null) : rate(c)), volume: c.den, occurrences: instances };
    });
    return { says: `${plain(k.name)} by position in the ${plain(cycle)} cycle over ${win.label}${k.kind === "sum" ? " (the average total for one occurrence of each position)" : ""}.`, columns: ["position", "value", "volume", "occurrences"], rows: out, rows_total: out.length, notes: [] };
  }
}

/** The sentence every answer carries about itself. */
export const exploratoryNote = (): string => EXPLORATORY_SAYS;
