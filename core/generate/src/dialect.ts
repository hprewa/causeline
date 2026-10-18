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
  /** SQL expression bucketing the time column at a level: the pack's own SQL when given, else the built-in one. */
  timeBucket(level: string, custom: string | undefined, timeColumn: string): string;
  /** SQL for where a timestamp falls in a cycle (its slot), and for one occurrence of that slot (its instance). */
  slotSql(slot: SlotSpec, timeColumn: string): { slot: string; instance: string; cycleDays: number };
}
