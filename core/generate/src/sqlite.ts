import { BUILTIN_SLOT_SQL, BUILTIN_TIME_LEVEL_SQL, type BuiltinSlot } from "@causeline/schema";
import type { Dialect } from "./dialect.js";

export const sqlite: Dialect = {
  name: "sqlite",
  toolType: "sqlite-sql",
  quote: (id) => `"${id}"`,
  timeBucket(level, custom, timeColumn) {
    if (custom) return custom;
    const template = BUILTIN_TIME_LEVEL_SQL.sqlite[level as keyof (typeof BUILTIN_TIME_LEVEL_SQL)["sqlite"]];
    if (!template) throw new Error(`no sqlite SQL for built-in time level "${level}"`);
    return template.replaceAll("%COL%", this.quote(timeColumn));
  },
  slotSql(slot, timeColumn) {
    const col = this.quote(timeColumn);
    if (slot.builtin) {
      const t = BUILTIN_SLOT_SQL.sqlite[slot.builtin as BuiltinSlot];
      if (!t) throw new Error(`no sqlite SQL for built-in cycle "${slot.builtin}"`);
      return { slot: t.slot.replaceAll("%COL%", col), instance: t.instance.replaceAll("%COL%", col), cycleDays: t.cycleDays };
    }
    return { slot: slot.expr!, instance: slot.instance!, cycleDays: slot.cycleDays! };
  },
};
