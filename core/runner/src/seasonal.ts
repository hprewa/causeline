import type { Ontology } from "@causeline/schema";
import type { Bucket, Components } from "./types.js";

/** The slots an ontology declares: cycles first, then calendar attributes. */
export interface SlotNames {
  /** Every slot, in a stable order. */
  all: string[];
  /** The calendar attributes among them (two-valued flags such as a holiday). */
  calendar: string[];
}

export function slotNamesOf(ont: Ontology): SlotNames {
  const s = ont.time.seasonality;
  if (s === "none") return { all: [], calendar: [] };
  return { all: [...s.cycles, ...s.calendar], calendar: [...s.calendar] };
}

/** The slots that are constant inside a bucket, as {slot: value}. A week has none of a weekday's; a day has. */
export function constantSlots(b: Bucket, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = b.slots?.[n];
    if (v !== null && v !== undefined) out[n] = v;
  }
  return out;
}

export interface Expected {
  /** Baseline components of the buckets that share the bucket's slots. Null when there are none to compare with. */
  base: Components | null;
  /** How many baseline buckets that is. */
  matches: number;
}

/**
 * Like-for-like expectation for one bucket: the baseline buckets that fall at the same place in
 * every cycle the bucket is constant in. A Saturday is compared with Saturdays; a holiday only with
 * holidays; a bucket that spans a whole cycle (a week) with all the baseline buckets.
 * "No comparable baseline" is a real answer (a holiday when the baseline has none): the caller must
 * not judge that bucket rather than compare it with something that is not like it.
 */
export function expectedFor(bucket: Bucket, baseline: Bucket[], names: string[]): Expected {
  const want = constantSlots(bucket, names);
  const keys = Object.keys(want);
  const matched = keys.length === 0 ? baseline : baseline.filter((b) => keys.every((k) => b.slots?.[k] === want[k]));
  if (matched.length === 0) return { base: null, matches: 0 };
  let num = 0;
  let den = 0;
  let sq: number | undefined = 0;
  for (const b of matched) {
    num += b.num;
    den += b.den;
    sq = sq !== undefined && b.sq !== undefined ? sq + b.sq : undefined;
  }
  return { base: { num, den, ...(sq !== undefined ? { sq } : {}) }, matches: matched.length };
}

/** Does a bucket fall inside a slot filter (every slot in the filter has one of the listed values)? */
export function matchesFilter(b: Bucket, filter: Record<string, string>): boolean {
  return Object.entries(filter).every(([name, list]) => {
    const v = b.slots?.[name];
    return v !== null && v !== undefined && list.split(",").includes(v);
  });
}

/** The slot filter that makes a node query's baseline match a narrowed window: every slot the buckets agree on. */
export function slotFilterFor(buckets: Bucket[], names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const values = new Set<string>();
    let constant = buckets.length > 0;
    for (const b of buckets) {
      const v = b.slots?.[n];
      if (v === null || v === undefined) constant = false;
      else values.add(v);
    }
    if (constant && values.size > 0) out[n] = [...values].sort().join(",");
  }
  return out;
}
