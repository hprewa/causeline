/** A cycle to turn into SQL: a built-in by name, or the pack's own expression. */
export interface SlotSpec {
  builtin?: string;
  expr?: string;
  instance?: string;
  cycleDays?: number;
}

/** Everything dialect-specific the generator needs. SQLite first; others are post-v1. */
export interface Dialect {
  name: string;
  /** Toolbox tool `type` for this source kind. */
  toolType: string;
  quote(identifier: string): string;
  /** How a tool parameter is written in a statement: `?` (read in order of appearance) or a named placeholder. */
  param(name: string): string;
  /** A parameter that carries a timestamp, written so it compares with the time column (some databases need an explicit conversion). */
  timeParam(name: string): string;
  /** `expr` as text. */
  text(expr: string): string;
  /** True when `expr`, as text, is one of the values in the comma-separated text `list`. */
  inList(list: string, expr: string): string;
  /** The number of rows where `expr` is NULL, as an aggregate. */
  countNulls(expr: string): string;
  /** An aggregate joining `expr` values with `separator`. */
  stringAgg(expr: string, separator: string): string;
  /** A timestamp expression as 'YYYY-MM-DD HH:MM:SS' text, so results look the same in every database. */
  timestampText(expr: string): string;
  /** SQL expression bucketing the time column at a level: the pack's own SQL when given, else the built-in one. */
  timeBucket(level: string, custom: string | undefined, timeColumn: string): string;
  /** SQL for where a timestamp falls in a cycle (its slot), and for one occurrence of that slot (its instance). */
  slotSql(slot: SlotSpec, timeColumn: string): { slot: string; instance: string; cycleDays: number };
}
