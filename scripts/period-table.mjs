#!/usr/bin/env node
// Prints how natural periods resolve to dates against a given "today": node scripts/period-table.mjs [YYYY-MM-DD]
// Each row is the structure an agent fills in for the words on the left; the dates are worked out by code.
import { parseDay, resolveSpec, toWindow } from "../core/intent/dist/src/index.js";

const todayText = process.argv[2] ?? "2026-10-14";
const today = parseDay(todayText);
if (today === null) throw new Error(`"${todayText}" is not a date (YYYY-MM-DD)`);
const weekday = new Date(today * 86_400_000).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

const rel = (unit, offset = 1, count = 1) => ({ kind: "relative", unit, offset, count });
const rows = [
  ["yesterday", rel("day")],
  ["last week", rel("week")],
  ["last 4 weeks", rel("week", 1, 4)],
  ["last 7 days", rel("day", 1, 7)],
  ["last 30 days", rel("day", 1, 30)],
  ["last month", rel("month")],
  ["the last 3 months", rel("month", 1, 3)],
  ["last quarter", rel("quarter")],
  ["last year", rel("year")],
  ["this week so far", rel("week", 0)],
  ["two weeks ago", rel("week", 2)],
  ["month to date", { kind: "to_date", unit: "month" }],
  ["year to date", { kind: "to_date", unit: "year" }],
  ["since 1 August", { kind: "since", date: "2026-08-01" }],
  ["Q3", { kind: "calendar", unit: "quarter", index: 3 }],
  ["Q2", { kind: "calendar", unit: "quarter", index: 2 }],
  ["Q4", { kind: "calendar", unit: "quarter", index: 4 }],
  ["August", { kind: "calendar", unit: "month", index: 8 }],
  ["December", { kind: "calendar", unit: "month", index: 12 }],
  ["2025", { kind: "calendar", unit: "year", year: 2025 }],
  ["1 to 31 August", { kind: "range", start: "2026-08-01", end: "2026-08-31" }],
];

console.log(`today: ${weekday} ${todayText} (periods end at the last complete day; weeks run Monday to Sunday)\n`);
const width = Math.max(...rows.map((r) => r[0].length));
for (const [words, spec] of rows) {
  const r = resolveSpec(spec, { today, labels: [] });
  console.log(`${words.padEnd(width)}  ${"span" in r ? `${toWindow(r.span).start} .. ${toWindow(r.span).end}  ${toWindow(r.span).days}d` : `(asks) ${r.problem}`}`);
}
