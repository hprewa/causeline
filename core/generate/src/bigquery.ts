import { BUILTIN_SLOT_SQL, BUILTIN_TIME_LEVEL_SQL, type BuiltinSlot } from "@causeline/schema";
import type { Dialect } from "./dialect.js";

/**
 * BigQuery (GoogleSQL) through Toolbox's `bigquery-sql` tools. Parameters are named (`@name`) and always strings,
 * so timestamp parameters are converted with TIMESTAMP(); the time column of a fact must be a TIMESTAMP.
 */
export const bigquery: Dialect = {
  name: "bigquery",
  toolType: "bigquery-sql",
  quote: (id) => `\`${id}\``,
  param: (name) => `@${name}`,
  timeParam: (name) => `TIMESTAMP(@${name})`,
  text: (expr) => `CAST(${expr} AS STRING)`,
  inList: (list, expr) => `STRPOS(CONCAT(',', ${list}, ','), CONCAT(',', CAST(${expr} AS STRING), ',')) > 0`,
  countNulls: (expr) => `COUNTIF(${expr} IS NULL)`,
  stringAgg: (expr, separator) => `STRING_AGG(${expr}, '${separator}')`,
  timestampText: (expr) => `FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%E*S', ${expr})`,
  timeBucket(level, custom, timeColumn) {
    if (custom) return custom;
    const template = BUILTIN_TIME_LEVEL_SQL.bigquery[level as keyof (typeof BUILTIN_TIME_LEVEL_SQL)["bigquery"]];
    if (!template) throw new Error(`no bigquery SQL for built-in time level "${level}"`);
    return template.replaceAll("%COL%", this.quote(timeColumn));
  },
  slotSql(slot, timeColumn) {
    const col = this.quote(timeColumn);
    if (slot.builtin) {
      const t = BUILTIN_SLOT_SQL.bigquery[slot.builtin as BuiltinSlot];
      if (!t) throw new Error(`no bigquery SQL for built-in cycle "${slot.builtin}"`);
      return { slot: t.slot.replaceAll("%COL%", col), instance: t.instance.replaceAll("%COL%", col), cycleDays: t.cycleDays };
    }
    return { slot: slot.expr!, instance: slot.instance!, cycleDays: slot.cycleDays! };
  },
};
