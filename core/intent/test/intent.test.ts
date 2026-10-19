import { test } from "node:test";
import assert from "node:assert/strict";
import { Intent, IntentPatch, type Ontology, type PeriodSpec } from "@causeline/schema";
import { mergeIntent, parseDay, resolveSpec, toWindow, validateIntent, type IntentEnv, type PeriodContext } from "../src/index.js";

const ontology = {
  time: { levels: ["year", "quarter", "month", "week", "day", "hour"], seasonality: "none" },
  hierarchies: { place: ["region", "site"] },
  dimensions: ["channel"],
  metrics: {
    on_time_rate: { type: "ratio", direction: "higher_is_better", min_volume: 0, synonyms: ["punctuality"] },
    volume: { type: "sum", direction: "higher_is_better", min_volume: 0, synonyms: ["how many"] },
    volume_per_unit: { type: "sum", direction: "higher_is_better", min_volume: 0 },
  },
} as unknown as Ontology;

const members: Record<string, string[]> = { region: ["North", "South"], site: ["site_1", "site_2", "Harbour View"], channel: ["web", "phone"] };

// Wednesday 2026-10-14 is "today"; the data holds 2025-01-01 .. 2026-10-13
const env = (over: Partial<IntentEnv> = {}): IntentEnv => ({
  ontology,
  today: "2026-10-14",
  as_of: "today",
  data: { start: "2025-01-01", end: "2026-10-13" },
  labels: [{ label: "2026-W40", start: "2026-09-28", end: "2026-10-04" }, { label: "2026-W41", start: "2026-10-05", end: "2026-10-11" }],
  lookup: async (_kpi, concept) => members[concept] ?? [],
  ...over,
});

const ctx = (today = "2026-10-14"): PeriodContext => ({ today: parseDay(today)!, labels: [] });
const win = (spec: PeriodSpec, today?: string) => {
  const r = resolveSpec(spec, ctx(today));
  assert.ok("span" in r, JSON.stringify(r));
  const w = toWindow(r.span);
  return `${w.start}..${w.end}`;
};

test("natural periods resolve to exact whole days against today", () => {
  // today is Wednesday 14 October 2026; weeks run Monday to Sunday
  const table: [string, PeriodSpec, string][] = [
    ["yesterday", { kind: "relative", unit: "day", offset: 1, count: 1 }, "2026-10-13..2026-10-13"],
    ["last week", { kind: "relative", unit: "week", offset: 1, count: 1 }, "2026-10-05..2026-10-11"],
    ["last 4 weeks", { kind: "relative", unit: "week", offset: 1, count: 4 }, "2026-09-14..2026-10-11"],
    ["last 7 days", { kind: "relative", unit: "day", offset: 1, count: 7 }, "2026-10-07..2026-10-13"],
    ["last month", { kind: "relative", unit: "month", offset: 1, count: 1 }, "2026-09-01..2026-09-30"],
    ["the last 3 months", { kind: "relative", unit: "month", offset: 1, count: 3 }, "2026-07-01..2026-09-30"],
    ["last quarter", { kind: "relative", unit: "quarter", offset: 1, count: 1 }, "2026-07-01..2026-09-30"],
    ["this week so far", { kind: "relative", unit: "week", offset: 0, count: 1 }, "2026-10-12..2026-10-13"],
    ["two weeks ago", { kind: "relative", unit: "week", offset: 2, count: 1 }, "2026-09-28..2026-10-04"],
    ["year to date", { kind: "to_date", unit: "year" }, "2026-01-01..2026-10-13"],
    ["month to date", { kind: "to_date", unit: "month" }, "2026-10-01..2026-10-13"],
    ["since 1 August", { kind: "since", date: "2026-08-01" }, "2026-08-01..2026-10-13"],
    ["Q3", { kind: "calendar", unit: "quarter", index: 3 }, "2026-07-01..2026-09-30"],
    ["Q2", { kind: "calendar", unit: "quarter", index: 2 }, "2026-04-01..2026-06-30"],
    ["Q4 (this quarter, so far)", { kind: "calendar", unit: "quarter", index: 4 }, "2026-10-01..2026-10-13"],
    ["Q1 (this year, finished)", { kind: "calendar", unit: "quarter", index: 1 }, "2026-01-01..2026-03-31"],
    ["August", { kind: "calendar", unit: "month", index: 8 }, "2026-08-01..2026-08-31"],
    ["December (not reached yet this year)", { kind: "calendar", unit: "month", index: 12 }, "2025-12-01..2025-12-31"],
    ["October (this month, so far)", { kind: "calendar", unit: "month", index: 10 }, "2026-10-01..2026-10-13"],
    ["2025", { kind: "calendar", unit: "year", year: 2025 }, "2025-01-01..2025-12-31"],
    ["February 2024 (leap year)", { kind: "calendar", unit: "month", index: 2, year: 2024 }, "2024-02-01..2024-02-29"],
    ["1 to 31 August", { kind: "range", start: "2026-08-01", end: "2026-08-31" }, "2026-08-01..2026-08-31"],
  ];
  for (const [words, spec, want] of table) assert.equal(win(spec), want, words);
});

test("weeks start on Monday, including when today is a Sunday or a Monday", () => {
  const lastWeek: PeriodSpec = { kind: "relative", unit: "week", offset: 1, count: 1 };
  assert.equal(win(lastWeek, "2026-10-18"), "2026-10-05..2026-10-11", "Sunday");
  assert.equal(win(lastWeek, "2026-10-19"), "2026-10-12..2026-10-18", "Monday");
});

test("periods never include today; a span with no finished day is refused, not shrunk to nothing", () => {
  for (const spec of [{ kind: "relative", unit: "day", offset: 0, count: 1 }, { kind: "to_date", unit: "week" }] as PeriodSpec[]) {
    const r = resolveSpec(spec, ctx("2026-10-12"));
    assert.ok("problem" in r, JSON.stringify(spec));
  }
  assert.ok("problem" in resolveSpec({ kind: "since", date: "2026-11-01" }, ctx()));
  assert.ok("problem" in resolveSpec({ kind: "calendar", unit: "quarter", index: 5 }, ctx()));
  assert.ok("problem" in resolveSpec({ kind: "range", start: "2026-02-30", end: "2026-03-01" }, ctx()));
  assert.ok("problem" in resolveSpec({ kind: "range", start: "2026-03-05", end: "2026-03-01" }, ctx()));
});

test("property: relative spans of whole units are contiguous, exact, and never cross today", () => {
  const units = ["day", "week", "month", "quarter", "year"] as const;
  for (let t = parseDay("2024-01-01")!; t < parseDay("2025-03-31")!; t += 11) {
    const todayText = new Date(t * 86_400_000).toISOString().slice(0, 10);
    for (const unit of units) for (const count of [1, 2, 3]) {
      const a = resolveSpec({ kind: "relative", unit, offset: 1, count }, { today: t, labels: [] });
      assert.ok("span" in a, `${todayText} ${unit} ${count}`);
      assert.ok(a.span.end <= t - 1, "ends before today");
      assert.ok(a.span.whole, "offset 1 is always whole");
      const b = resolveSpec({ kind: "relative", unit, offset: 1 + count, count }, { today: t, labels: [] });
      assert.ok("span" in b);
      assert.equal(b.span.end + 1, a.span.start, `${todayText} ${unit} ${count}: the span before touches this one`);
    }
  }
});

test("a comparison resolves to the other span: Q3 against Q2, the previous unit, the same dates last year", async () => {
  const base: Intent = { kpi: "on_time_rate", task: "compare", filters: {}, period: { kind: "calendar", unit: "quarter", index: 3 } };
  const q = async (comparison: unknown) => {
    const r = await validateIntent(Intent.parse({ ...base, comparison: IntentPatch.parse({ comparison }).comparison }), env());
    assert.equal(r.status, "ready", JSON.stringify(r));
    return r.status === "ready" ? r.resolved : null;
  };
  const viaPeriod = await q({ kind: "period", period: { kind: "calendar", unit: "quarter", index: 2 } });
  assert.deepEqual([viaPeriod!.against!.start, viaPeriod!.against!.end], ["2026-04-01", "2026-06-30"]);
  const prev = await q("previous");
  assert.deepEqual([prev!.against!.start, prev!.against!.end], ["2026-04-01", "2026-06-30"], "the previous quarter");
  const ly = await q("same_last_year");
  assert.deepEqual([ly!.against!.start, ly!.against!.end], ["2025-07-01", "2025-09-30"]);

  // a span of days has no unit, so "previous" is just as long, right before
  const days = await validateIntent(Intent.parse({ ...base, period: { kind: "range", start: "2026-08-10", end: "2026-08-16" }, comparison: { kind: "previous" } }), env());
  assert.equal(days.status === "ready" && days.resolved.against!.start, "2026-08-03");
});

test("a month so far is compared with the same number of days of the month before", async () => {
  const r = await validateIntent(Intent.parse({ kpi: "volume", task: "compare", period: { kind: "to_date", unit: "month" }, comparison: { kind: "previous" }, filters: {} }), env());
  assert.equal(r.status, "ready");
  if (r.status === "ready") assert.deepEqual([r.resolved.window.start, r.resolved.window.end, r.resolved.against!.start, r.resolved.against!.end], ["2026-10-01", "2026-10-13", "2026-09-01", "2026-09-13"]);
});

test("a ready intent is read back in plain words with the real dates", async () => {
  const r = await validateIntent(Intent.parse({ kpi: "on_time_rate", task: "deep_rca", period: { kind: "relative", unit: "week" }, aggregation: "daily", filters: { site: "site_1" } }), env());
  assert.equal(r.status, "ready");
  if (r.status !== "ready") return;
  assert.equal(r.resolved.aggregation, "day");
  assert.match(r.playback, /deep dive into on time rate \(site site_1\) for last week \(5–11 October 2026\), by day/);
});

test("asks exactly one question, in a fixed order: KPI, task, period, then the rest", async () => {
  const slots: string[] = [];
  let intent: Intent = { filters: { site: "nowhere" } };
  const answer: Record<string, Partial<Intent>> = {
    kpi: { kpi: "volume" },
    task: { task: "value" },
    period: { period: { kind: "relative", unit: "week", offset: 1, count: 1 } },
    filters: { filters: { site: "site_2" } },
  };
  for (let i = 0; i < 6; i++) {
    const r = await validateIntent(intent, env());
    if (r.status === "ready") break;
    slots.push(r.slot);
    intent = { ...intent, ...answer[r.slot] };
  }
  assert.deepEqual(slots, ["kpi", "task", "period", "filters"]);
});

test("a KPI is found by its name, a synonym, or one clear near-match; two possible ones are asked about", async () => {
  const read = async (kpi: string) => validateIntent({ kpi, task: "value", period: { kind: "relative", unit: "week", offset: 1, count: 1 }, filters: {} }, env());
  for (const [said, kpi] of [["on_time_rate", "on_time_rate"], ["On time rate", "on_time_rate"], ["punctuality", "on_time_rate"], ["how many", "volume"]]) {
    const r = await read(said);
    assert.equal(r.status === "ready" && r.resolved.kpi, kpi, said);
  }
  const unknown = await read("revenue");
  assert.equal(unknown.status, "ask");
  assert.ok(unknown.status === "ask" && unknown.slot === "kpi" && unknown.options.length === 3);
});

test("a filter value must exist in the data; a near spelling is offered, never silently taken", async () => {
  const f = (filters: Record<string, string>) => validateIntent({ kpi: "volume", task: "value", period: { kind: "relative", unit: "week", offset: 1, count: 1 }, filters }, env());
  const ok = await f({ region: "north" });
  assert.equal(ok.status === "ready" && ok.resolved.filters.region, "North", "case is the data's, not the person's");
  const spaced = await f({ site: "harbour view" });
  assert.equal(spaced.status === "ready" && spaced.resolved.filters.site, "Harbour View");
  const padded = await f({ site: "site 01" });
  assert.equal(padded.status === "ready" && padded.resolved.filters.site, "site_1", "01 and 1 are the same number");
  const spacedNumber = await f({ site: "Site 2" });
  assert.equal(spacedNumber.status === "ready" && spacedNumber.resolved.filters.site, "site_2");
  const typo = await f({ region: "Nroth" });
  assert.ok(typo.status === "ask" && typo.slot === "filters" && typo.detail === "region" && typo.options.some((o) => o.value === "North"), JSON.stringify(typo));
  const missing = await f({ region: "Atlantis" });
  assert.ok(missing.status === "ask" && /Some that exist: North, South/.test(missing.question), JSON.stringify(missing));
  const concept = await f({ country: "UK" });
  assert.ok(concept.status === "ask" && concept.slot === "filters" && /region/.test(concept.question));
});

test("aggregation is a level of the ontology, spoken however people speak, and must fit the period", async () => {
  const a = (aggregation: string, period: PeriodSpec = { kind: "relative", unit: "week", offset: 1, count: 4 }) => validateIntent({ kpi: "volume", task: "trend", period, aggregation, filters: {} }, env());
  for (const [said, level] of [["day", "day"], ["daily", "day"], ["by week", "week"], ["Weekly", "week"], ["hourly", "hour"], ["monthly", "month"]]) {
    const r = await a(said, { kind: "relative", unit: "month", offset: 1, count: 6 });
    assert.equal(r.status === "ready" && r.resolved.aggregation, level, said);
  }
  const bad = await a("fortnightly");
  assert.ok(bad.status === "ask" && bad.slot === "aggregation" && bad.options.length === 6);
  const tooCoarse = await a("month", { kind: "relative", unit: "day", offset: 1, count: 1 });
  assert.ok(tooCoarse.status === "ask" && tooCoarse.slot === "aggregation" && tooCoarse.options.some((o) => o.value === "hour"));
});

test("a comparison needs a comparison task, and a comparison task needs a comparison", async () => {
  const period: PeriodSpec = { kind: "relative", unit: "week", offset: 1, count: 1 };
  const noOther = await validateIntent({ kpi: "volume", task: "compare", period, filters: {} }, env());
  assert.ok(noOther.status === "ask" && noOther.slot === "comparison" && noOther.options.length === 2);
  const stray = await validateIntent({ kpi: "volume", task: "deep_rca", period, comparison: { kind: "previous" }, filters: {} }, env());
  assert.ok(stray.status === "ask" && stray.slot === "task");
  const same = await validateIntent({ kpi: "volume", task: "compare", period, comparison: { kind: "period", period }, filters: {} }, env());
  assert.ok(same.status === "ask" && /same period/.test(same.question));
});

test("a period the data does not hold is explained with the dates the data does cover", async () => {
  const r = await validateIntent({ kpi: "volume", task: "value", period: { kind: "calendar", unit: "year", year: 2024 }, filters: {} }, env());
  assert.ok(r.status === "ask" && r.slot === "period" && /covers 2025-01-01 to 2026-10-13/.test(r.question), JSON.stringify(r));
  // the data stops short of "yesterday"
  const late = await validateIntent({ kpi: "volume", task: "value", period: { kind: "relative", unit: "day", offset: 1, count: 1 }, filters: {} }, env({ data: { start: "2025-01-01", end: "2026-10-10" } }));
  assert.ok(late.status === "ask" && /2026-10-10/.test(late.question));
});

test("data that stops at a fixed date: last week is the last week the data holds, whatever today is", async () => {
  const fixed = env({ as_of: "data_end", today: "2031-01-01", data: { start: "2026-01-01", end: "2026-03-11" } }); // ends on a Wednesday
  const r = await validateIntent({ kpi: "volume", task: "value", period: { kind: "relative", unit: "week", offset: 1, count: 1 }, filters: {} }, fixed);
  assert.equal(r.status === "ready" && r.resolved.window.start, "2026-03-02");
  assert.equal(r.status === "ready" && r.resolved.window.end, "2026-03-08");
  const y = await validateIntent({ kpi: "volume", task: "value", period: { kind: "relative", unit: "day", offset: 1, count: 1 }, filters: {} }, fixed);
  assert.equal(y.status === "ready" && y.resolved.window.end, "2026-03-11", "yesterday is the data's last day");
});

test("a period label of the data resolves to the days it covers", async () => {
  const r = await validateIntent({ kpi: "volume", task: "value", period: { kind: "label", label: "2026-w41" }, filters: {} }, env());
  assert.ok(r.status === "ready");
  if (r.status === "ready") assert.deepEqual([r.resolved.window.start, r.resolved.window.end, r.resolved.window.label], ["2026-10-05", "2026-10-11", "2026-W41"]);
  const missing = await validateIntent({ kpi: "volume", task: "value", period: { kind: "label", label: "2026-W41x" }, filters: {} }, env());
  assert.ok(missing.status === "ask" && missing.slot === "period");
});

test("patches merge: left out keeps, null clears, a filter set to null is removed", () => {
  let intent: Intent = { filters: {} };
  intent = mergeIntent(intent, { kpi: "volume", task: "value", period: { kind: "relative", unit: "week", offset: 1, count: 1 }, filters: { region: "North" } });
  intent = mergeIntent(intent, { filters: { site: "site_1" } });
  assert.deepEqual(intent.filters, { region: "North", site: "site_1" });
  intent = mergeIntent(intent, { filters: { region: null }, task: "trend" });
  assert.deepEqual(intent.filters, { site: "site_1" });
  assert.equal(intent.kpi, "volume");
  assert.equal(intent.task, "trend");
  intent = mergeIntent(intent, { period: null });
  assert.equal(intent.period, undefined);
});
