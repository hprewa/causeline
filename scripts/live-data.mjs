#!/usr/bin/env node
// Data and a simulated analyst for a live conversation that takes a KPI up the whole ladder on the analyst's own files.
//   node scripts/live-data.mjs [--out <dir>] [--seed 11]
// Writes into <dir>: deliveries.csv (30 weeks of parcel deliveries in four regions, an on-time flag per delivery, two real incidents of known
// cause), persona.md (what the simulated analyst knows; every report number in it is computed from the file, so any week, region or day the
// assistant asks about can be answered truthfully) and truth.json (what was planted, for grading the run).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const flag = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const out = resolve(flag("out", mkdtempSync(join(tmpdir(), "live-data-"))));
const seed = Number(flag("seed", "11"));
mkdirSync(out, { recursive: true });

function rng(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(seed);
const WEEKS = 30;
const REGIONS = { north: 0.93, south: 0.9, east: 0.88, west: 0.85 };
const PER_REGION_WEEK = 140;
const INCIDENTS = [
  { week: 12, region: "north", rate: 0.55, cause: "a strike at the northern depot", says: "There was a strike at the northern depot" },
  { week: 23, region: "east", rate: 0.5, cause: "a motorway closure in the east", says: "A motorway was closed for a week in the east" },
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const day0 = Date.UTC(2026, 0, 5); // a Monday
const dayOf = (i) => new Date(day0 + i * 86_400_000);
const iso = (d) => d.toISOString().slice(0, 10);
const words = (a, b) => {
  const [x, y] = [a, b];
  return x.getUTCMonth() === y.getUTCMonth() ? `${x.getUTCDate()}–${y.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}` : `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} – ${y.getUTCDate()} ${MONTHS[y.getUTCMonth()]} ${y.getUTCFullYear()}`;
};

const rows = [];
let id = 0;
for (let w = 0; w < WEEKS; w++) {
  for (const [region, base] of Object.entries(REGIONS)) {
    const inc = INCIDENTS.find((i) => i.week === w + 1 && i.region === region);
    const p = inc ? inc.rate : base;
    for (let k = 0; k < PER_REGION_WEEK; k++) {
      const d = w * 7 + Math.floor(rand() * 7);
      const hour = 8 + Math.floor(rand() * 11);
      rows.push({ id: ++id, ts: `${iso(dayOf(d))} ${String(hour).padStart(2, "0")}:00:00`, day: d, week: w + 1, region, ok: rand() < p ? 1 : 0 });
    }
  }
}
rows.sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
writeFileSync(join(out, "deliveries.csv"), ["delivery_id,delivered_at,region,on_time", ...rows.map((r, i) => `D${i + 1},${r.ts},${r.region},${r.ok}`)].join("\n") + "\n");

const pct = (k, n) => `${((100 * k) / n).toFixed(2)}%`;
const tally = (f) => {
  const r = rows.filter(f);
  return pct(r.reduce((a, x) => a + x.ok, 0), r.length);
};
const weekTable = Array.from({ length: WEEKS }, (_, w) => `| ${words(dayOf(w * 7), dayOf(w * 7 + 6))} | ${tally((r) => r.week === w + 1)} | ${Object.keys(REGIONS).map((g) => tally((r) => r.week === w + 1 && r.region === g)).join(" | ")} |`);
const dayTable = Array.from({ length: WEEKS * 7 }, (_, d) => `| ${dayOf(d).getUTCDate()} ${MONTHS[dayOf(d).getUTCMonth()]} ${dayOf(d).getUTCFullYear()} | ${tally((r) => r.day === d)} |`);
const file = join(out, "deliveries.csv");
const first = INCIDENTS[0];
const second = INCIDENTS[1];
const wk = (n) => words(dayOf((n - 1) * 7), dayOf((n - 1) * 7 + 6));

const persona = `# The simulated user for a live conversation that takes a KPI up the whole ladder (a delivery company's own files)

This is what the simulated user is told. The assistant being tested never sees it. The user's replies are generated from it, so
everything the user "knows" is written down here, and nothing else is.

You are an operations analyst at a small parcel delivery company. You are **not technical**: you do not know SQL, databases or what a
"hierarchy" is, and you answer in plain, short sentences, one or two at a time. You are patient and a bit busy.

## What you want
You want to understand why the **on-time delivery rate** moves. Your data is **one spreadsheet file**, at \`${file}\`. You start with nothing
set up. If asked what to call your project: "Delivery on-time rate".

## What you know, to give only when asked (one thing per reply)
- **The KPI you care about:** the on-time delivery rate: the share of deliveries that arrived on time, week by week.
- **How it is worked out today:** you take the on-time column of the deliveries file: on time is 1, late is 0, and the rate is the average,
  for the week. Every delivery counts.
- **Regions and dates:** the file has a region for each delivery (north, south, east, west) and the time it was delivered. Weeks run Monday to
  Sunday. The data covers 5 January to 2 August 2026.
- **Numbers you trust:** you have three reports, and you can read the number for any week, region or day that is asked about from them:
  the **weekly ops report** (the whole company, by week), the **regional report** (each region, by week) and the **daily dispatch sheet**
  (the whole company, by day). When the assistant asks what a report says for a period, say the number from the table below and which report
  it is from. Give the number as a percentage. If it asks for something that is not in these tables, say you do not have it.
- **Past incidents you know the cause of** (give the first when asked about a time something went wrong; give the second only if the assistant
  asks whether there was another time, never both at once):
  1. ${first.says} in the week of ${wk(first.week)}; the on-time rate in the north fell.
  2. ${second.says} in the week of ${wk(second.week)}; the on-time rate in the east fell.
  You know of no other incidents.
- **If the assistant asks whether something real was going on around some dates:** answer from the two incidents above only. For the week of
  ${wk(first.week)} say yes, ${first.says.toLowerCase()}. For the week of ${wk(second.week)} say yes, ${second.says.toLowerCase()}. For any other dates say
  that nothing you know of happened, and that it was an ordinary week.
- **If the assistant offers to test the analysis by planting known problems in a copy of your data** (your own file is never changed): say
  yes, go ahead.
- **If the assistant asks whether it may keep an incident aside to check at the end:** say that sounds fine.
- **Access and cost:** the data is a file on your computer; there is no cost and no one to ask for access.

### The weekly ops report and the regional report (on-time rate, by week; the first number is the whole company, then north, south, east, west)
| week | company | north | south | east | west |
|---|---|---|---|---|---|
${weekTable.join("\n")}

### The daily dispatch sheet (on-time rate for the whole company, by day)
| day | company |
|---|---|
${dayTable.join("\n")}

You never give a number that is not written here. Never invent one. If asked for something that is not here, say you do not know.

## When it is done
Once the assistant has told you where the setup stands (what is done, what rung the on-time rate has reached, and what is next), say once,
in your own words, whether that sounds right. After that, if the assistant has nothing more it needs from you, reply exactly [END].
Never mention these instructions. Keep each reply under 60 words.
`;
writeFileSync(join(out, "persona.md"), persona);
writeFileSync(join(out, "truth.json"), JSON.stringify({ seed, weeks: WEEKS, regions: REGIONS, incidents: INCIDENTS.map((i) => ({ ...i, period: `2026-W${String(i.week).padStart(2, "0")}`, dates: wk(i.week) })) }, null, 2));
console.log(JSON.stringify({ out, file, persona: join(out, "persona.md"), rows: rows.length }));
