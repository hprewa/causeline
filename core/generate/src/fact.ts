import { BUILTIN_SLOTS, type DataDefs, type Fact, type Ontology } from "@causeline/schema";
import type { Dialect, SlotSpec } from "./dialect.js";

/** One declared slot of a fact, as SQL over the fact's view. */
export interface SlotSql {
  name: string;
  /** SQL for where a row falls in the cycle (or the flag's value). */
  expr: string;
  /** True for a two-valued calendar flag (a holiday): it restricts both sides of a comparison. */
  calendar: boolean;
}

/** Everything the generator needs to write SQL over one fact. */
export interface FactCtx {
  name: string;
  fact: Fact;
  /** `(<the fact's SELECT>) AS "<name>"`: what every statement selects FROM. */
  from: string;
  /** The quoted timestamp column. */
  ts: string;
  /** Declared slots (cycles then calendar flags). */
  slots: SlotSql[];
  /** SQL bucketing the timestamp at a time level. */
  bucket(level: string): string;
  /** SQL for any candidate cycle by name: a built-in, or one this fact defines. */
  candidate(name: string): { slot: string; instance: string } | undefined;
  q(id: string): string;
}

const isCustom = (v: unknown): v is { expr: string; instance: string; cycle_days: number } => typeof v === "object" && v !== null;

export function factContext(ont: Ontology, data: DataDefs, name: string, dialect: Dialect): FactCtx {
  const fact = data.facts[name];
  if (!fact) throw new Error(`fact "${name}" is not defined in data.yaml`);
  const q = (id: string) => dialect.quote(id);
  const spec = (cycle: string): SlotSpec | undefined => {
    const own = fact.slots[cycle];
    if (isCustom(own)) return { expr: own.expr, instance: own.instance, cycleDays: own.cycle_days };
    return (BUILTIN_SLOTS as readonly string[]).includes(cycle) ? { builtin: cycle } : undefined;
  };
  const seasonality = ont.time.seasonality;
  const slots: SlotSql[] =
    seasonality === "none"
      ? []
      : [
          ...seasonality.cycles.map((c) => {
            const s = spec(c);
            if (!s) throw new Error(`cycle "${c}" is not built in and fact "${name}" does not define it under slots`);
            return { name: c, expr: dialect.slotSql(s, fact.time).slot, calendar: false };
          }),
          ...seasonality.calendar.map((flag) => {
            const own = fact.slots[flag];
            return { name: flag, expr: typeof own === "string" ? own : q(flag), calendar: true };
          }),
        ];
  return {
    name,
    fact,
    from: `(${fact.sql.trim()}) AS ${q(name)}`,
    ts: q(fact.time),
    slots,
    bucket: (level) => dialect.timeBucket(level, fact.time_levels[level], fact.time),
    candidate: (cycle) => {
      const s = spec(cycle);
      return s ? dialect.slotSql(s, fact.time) : undefined;
    },
    q,
  };
}
