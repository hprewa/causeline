import type { Bucket, ChildRow, Row } from "./types.js";

const n = (v: unknown): number => Number(v ?? 0);

/** Rows from a child-breakdown tool (node, cur_num, cur_den, base_num, base_den). */
export function toChildRows(rows: Row[]): ChildRow[] {
  return rows.map((r) => ({
    node: String(r.node),
    cur: { num: n(r.cur_num), den: n(r.cur_den), ...(r.cur_sq !== undefined ? { sq: n(r.cur_sq) } : {}) },
    base: { num: n(r.base_num), den: n(r.base_den), ...(r.base_sq !== undefined ? { sq: n(r.base_sq) } : {}) },
  }));
}

/** Rows from a time-series tool (bucket, bucket_start, bucket_end, num, den). */
export function toBuckets(rows: Row[]): Bucket[] {
  return rows.map((r) => {
    const slots: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(r)) if (k.startsWith("slot_")) slots[k.slice(5)] = v === null || v === undefined ? null : String(v);
    return {
      bucket: String(r.bucket),
      bucket_start: String(r.bucket_start),
      bucket_end: String(r.bucket_end),
      num: n(r.num),
      den: n(r.den),
      ...(r.sq !== undefined ? { sq: n(r.sq) } : {}),
      ...(Object.keys(slots).length > 0 ? { slots } : {}),
    };
  });
}
