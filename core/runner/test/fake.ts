import { generateTools } from "@causeline/generate";
import { DataDefs, Ontology, isRatioFormula, parseToolRef } from "@causeline/schema";
import type { Row, ToolCaller } from "../src/types.js";

/**
 * Neutral test domain: facts with two hierarchies and one flat dimension, and one metric of each
 * type: a ratio (m), totals (n_rows, total_amount), another ratio (avg_amount) and a product of
 * two drivers (volume_x_avg = n_rows x avg_amount).
 */
export const ontology = Ontology.parse({
  time: { levels: ["wk", "dy"], seasonality: "none" },
  hierarchies: { h1: ["a1", "a2"], h2: ["b1"] },
  dimensions: ["d1"],
  metrics: {
    m: { type: "ratio", direction: "higher_is_better", min_volume: 100 },
    n_rows: { type: "sum", direction: "lower_is_better", min_volume: 100 },
    total_amount: { type: "sum", direction: "lower_is_better", min_volume: 100 },
    avg_amount: { type: "ratio", direction: "lower_is_better", min_volume: 100 },
    volume_x_avg: { type: "product", drivers: ["n_rows", "avg_amount"], direction: "lower_is_better" },
  },
});

/** Where the neutral domain's numbers come from: one fact over a `facts` table. */
export const data = DataDefs.parse({
  source: "fake",
  facts: {
    facts: {
      sql: "SELECT * FROM facts",
      time: "ts",
      concepts: ["a1", "a2", "b1", "d1"],
      time_levels: { wk: "wk", dy: "dy" },
    },
  },
  evidence: { incidents: { sql: "SELECT * FROM incidents", time: "ts", about: ["a2"] } },
  metrics: {
    m: { fact: "facts", numerator: "ok" },
    n_rows: { fact: "facts", value: "1" },
    total_amount: { fact: "facts", value: "amount" },
    avg_amount: { fact: "facts", numerator: "amount" },
  },
});

/** What each generated tool answers: the index the runner finds tools in. */
export const meta = generateTools(ontology, data).meta;

/** The same domain with a declared weekly cycle: the weekday of each fact's date is its slot. */
export const seasonalOntology = Ontology.parse({ ...ontology, time: { ...ontology.time, seasonality: { cycles: ["weekday"], calendar: [] } } });
export const seasonalMeta = generateTools(seasonalOntology, data).meta;

/** Weekday of a fact, "0" (Sunday) .. "6", as the SQLite strftime('%w') slot would give it. */
const weekdayOf = (f: { ts: string }) => String(new Date(`${f.ts.slice(0, 10)}T00:00:00Z`).getUTCDay());

export interface Fact {
  ts: string;
  wk: string;
  dy: string;
  a1: string;
  a2: string;
  b1: string;
  d1: string;
  ok: number;
  amount: number;
}

export interface FaultSpec {
  /** Predicate over the fact's coordinates (week number 1..6, day 1..7). */
  where: (f: { week: number; day: number; a2: string; d1: string; b1: string }) => boolean;
  /** Share of rows (out of 10) that are ok inside the fault. */
  okOutOf10: number;
  /** Drop this share (out of 10) of the matching rows entirely. */
  dropOutOf10?: number;
  /** Multiply each row's amount by this inside the fault. */
  amountFactor?: number;
  /** Add this many extra copies (out of 10 rows) of the matching rows: more volume. */
  extraOutOf10?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Six weeks of data, 10 rows per (a2, b1, d1, day) cell. Outcomes follow an exact repeating
 * pattern (9 in 10 ok; amounts cycle through 10..14), so clean data has no sampling noise.
 */
export function buildFacts(faults: FaultSpec[] = [], weeks = 6): Fact[] {
  const facts: Fact[] = [];
  const counters = new Map<string, number>();
  for (let week = 1; week <= weeks; week++) {
    for (let day = 1; day <= 7; day++) {
      const date = new Date(Date.UTC(2026, 0, (week - 1) * 7 + day));
      const dateStr = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
      for (const a2 of ["P1", "P2", "Q1", "Q2"]) {
        for (const b1 of ["U", "V"]) {
          for (const d1 of ["X", "Y", "Z"]) {
            for (let i = 0; i < 10; i++) {
              const k = counters.get(`${a2}|${b1}|${d1}`) ?? 0;
              counters.set(`${a2}|${b1}|${d1}`, k + 1);
              const fault = faults.find((f) => f.where({ week, day, a2, d1, b1 }));
              if (fault?.dropOutOf10 && k % 10 < fault.dropOutOf10) continue;
              const row: Fact = {
                ts: `${dateStr} ${pad(i)}:00:00`,
                wk: `W${week}`,
                dy: `W${week}-D${day}`,
                a1: a2[0],
                a2,
                b1,
                d1,
                ok: k % 10 < (fault ? fault.okOutOf10 : 9) ? 1 : 0,
                amount: (10 + (k % 5)) * (fault?.amountFactor ?? 1),
              };
              facts.push(row);
              if (fault?.extraOutOf10 && i < fault.extraOutOf10) facts.push({ ...row });
            }
          }
        }
      }
    }
  }
  return facts;
}

/** Answers the generator's tool names from in-memory facts; unknown names throw. */
export class FakeToolCaller implements ToolCaller {
  private readonly names: Set<string>;
  private readonly metrics: [string, (typeof data.metrics)[string]][];
  private readonly cycles: string[];
  constructor(
    private readonly facts: Fact[],
    ont = ontology,
    /** Records the `incidents` evidence source can return (each has ts and a2). */
    private readonly incidents: Row[] = [],
  ) {
    this.names = new Set(generateTools(ont, data).tools.map((t) => t.name));
    this.metrics = Object.entries(data.metrics);
    this.cycles = ont.time.seasonality === "none" ? [] : ont.time.seasonality.cycles;
  }

  async call(ref: string, given: Record<string, string>): Promise<Row[]> {
    // a tool reference carries the values bound to it (a series tool's aggregation)
    const { name: tool, bound } = parseToolRef(ref);
    const p = { ...bound, ...given };
    if (!this.names.has(tool)) throw new Error(`fake: unknown tool "${tool}"`);
    if (tool === "incidents") {
      return this.incidents.filter((r) => String(r.ts) >= p.start && String(r.ts) <= p.end && (!p.a2 || r.a2 === p.a2));
    }
    if (tool.endsWith("_extent")) {
      const ts = this.facts.map((f) => f.ts).sort();
      return [{ n_rows: this.facts.length, min_ts: ts[0], max_ts: ts[ts.length - 1] }];
    }

    const inWindow = (f: Fact, s: string, e: string) => f.ts >= s && f.ts <= e;
    const cur = (f: Fact) => inWindow(f, p.cur_start, p.cur_end);
    // a cycle filter keeps only the baseline rows at the same weekdays as the narrowed window
    const allowed = p.s_weekday ? p.s_weekday.split(",") : null;
    const base = (f: Fact) => inWindow(f, p.base_start, p.base_end) && (!allowed || allowed.includes(weekdayOf(f)));

    // which metric is this tool for, and how are its components built from a fact?
    const [metric, def] = this.metrics.find(([name]) => tool === `${name}_series` || tool.startsWith(`${name}_by_`))!;
    // optional filters: any concept given a value confines the rows to it
    const confined = this.facts.filter((f) => ["a1", "a2", "b1", "d1"].every((c) => !p[c] || f[c as keyof Fact] === p[c]));
    const val = (f: Fact, expr: string) => (expr === "1" ? 1 : Number((f as unknown as Record<string, unknown>)[expr]));
    const numExpr = isRatioFormula(def) ? def.numerator : def.value;
    const denExpr = isRatioFormula(def) ? def.denominator : "1";
    const withSq = true; // like the generated tools, every metric reports the sum of squared numerators
    const sumOf = (rows: Fact[]) => ({
      num: rows.reduce((a, f) => a + val(f, numExpr), 0),
      den: rows.reduce((a, f) => a + val(f, denExpr), 0),
      sq: rows.reduce((a, f) => a + val(f, numExpr) ** 2, 0),
    });

    const groupWindows = (rows: Fact[], col: keyof Fact): Row[] => {
      const nodes = [...new Set(rows.filter((f) => cur(f) || base(f)).map((f) => String(f[col])))].sort();
      return nodes.map((node) => {
        const mine = rows.filter((f) => f[col] === node);
        const c = sumOf(mine.filter(cur));
        const b = sumOf(mine.filter(base));
        return {
          node,
          cur_num: c.num,
          cur_den: c.den,
          ...(withSq ? { cur_sq: c.sq } : {}),
          base_num: b.num,
          base_den: b.den,
          ...(withSq ? { base_sq: b.sq } : {}),
        };
      });
    };
    const series = (rows: Fact[], col: "wk" | "dy"): Row[] => {
      const inRange = rows.filter((f) => inWindow(f, p.start, p.end));
      const buckets = [...new Set(inRange.map((f) => f[col]))];
      return buckets
        .map((bucket) => {
          const mine = inRange.filter((f) => f[col] === bucket);
          const ts = mine.map((f) => f.ts).sort();
          const s = sumOf(mine);
          const days = new Set(mine.map(weekdayOf));
          const slots = this.cycles.length > 0 ? { slot_weekday: days.size === 1 ? [...days][0] : null } : {};
          return { bucket, bucket_start: ts[0], bucket_end: ts[ts.length - 1], num: s.num, den: s.den, ...(withSq ? { sq: s.sq } : {}), ...slots };
        })
        .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
    };

    if (tool === `${metric}_series`) return series(confined, p.aggregation as "wk" | "dy");
    return groupWindows(confined, tool.slice(`${metric}_by_`.length) as keyof Fact);
  }
}
