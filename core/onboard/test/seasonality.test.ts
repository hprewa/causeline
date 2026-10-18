import { test } from "node:test";
import assert from "node:assert/strict";
import { Ontology } from "@causeline/schema";
import { DEFAULT_THRESHOLDS } from "@causeline/runner";
import { chi2Survival, gammaQ, lnGamma } from "../src/chi2.js";
import { summarise, testCycle, type CycleResult } from "../src/seasonality.js";

const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

// --- the chi-square tail ---------------------------------------------------------------------------

test("lnGamma matches known values", () => {
  close(lnGamma(1), 0, 1e-10);
  close(lnGamma(5), Math.log(24), 1e-10);
  close(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10);
});

test("chi-square survival: exact for 2 df, textbook critical values, and tiny tails", () => {
  for (const x of [0.5, 3, 10, 40]) close(chi2Survival(x, 2), Math.exp(-x / 2), 1e-10);
  close(chi2Survival(3.841458820694124, 1), 0.05, 1e-6);
  close(chi2Survival(5.991464547107979, 2), 0.05, 1e-6);
  close(chi2Survival(12.591587243743977, 6), 0.05, 1e-6);
  assert.equal(chi2Survival(0, 5), 1);
  const tail = chi2Survival(200, 6);
  assert.ok(tail > 0 && tail < 1e-30, `a 200 on 6 df is astronomically unlikely, got ${tail}`);
  close(gammaQ(3, 2) + (1 - gammaQ(3, 2)), 1);
});

// --- one cycle -------------------------------------------------------------------------------------

/** Rows for a rate by weekday: 12 occurrences each, `perDay` rows a day, rate `rates[w]`. */
const weekdayRows = (rates: number[], perDay = 400) =>
  rates.map((r, w) => {
    const den = perDay * 12;
    const num = Math.round(den * r);
    return { slot: String(w), instances: 12, num, den, sq: num };
  });

const th = DEFAULT_THRESHOLDS;

test("a rate that differs by weekday is seasonal, with the peak and trough named", () => {
  const r = testCycle("m", "weekday", "cycle", "ratio", weekdayRows([0.85, 0.93, 0.93, 0.93, 0.93, 0.93, 0.88]), th);
  assert.equal(r.status, "seasonal");
  assert.equal(r.peak, "1");
  assert.equal(r.trough, "0");
  assert.ok(r.p! < 1e-6);
  assert.ok(r.amplitude! > 0.08);
});

test("sensitivity: a pattern of 3% of the level is found; specificity: identical positions are not", () => {
  const small = testCycle("m", "weekday", "cycle", "ratio", weekdayRows([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9 - 0.027], 3000), th);
  assert.equal(small.status, "seasonal", small.reason);
  const flat = testCycle("m", "weekday", "cycle", "ratio", weekdayRows([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]), th);
  assert.equal(flat.status, "not_seasonal");
  assert.ok(flat.p! > 0.5);
});

test("noise alone is not seasonal even over many positions", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  // 24 hourly positions, each a binomial-ish draw around the same 80%
  const rows = Array.from({ length: 24 }, (_, h) => {
    const den = 1500;
    let num = 0;
    for (let i = 0; i < den; i++) num += rnd() < 0.8 ? 1 : 0;
    return { slot: String(h), instances: 12, num, den, sq: num };
  });
  assert.notEqual(testCycle("m", "hour_of_day", "cycle", "ratio", rows, th).status, "seasonal");
});

test("a real but trivial pattern is statistically significant yet below the amplitude that matters", () => {
  const r = testCycle("m", "weekday", "cycle", "ratio", weekdayRows([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9 - 0.009], 200000), th);
  assert.equal(r.status, "not_seasonal");
  assert.ok(r.p! < th.season_p, "the difference is real");
  assert.match(r.reason, /only by/);
});

test("too little history is reported as cannot_assess with the count, never as 'not seasonal'", () => {
  const months = ["01", "02", "03"].map((m, i) => ({ slot: m, instances: 1, num: 900 - i * 100, den: 1000, sq: 900 - i * 100 }));
  const r = testCycle("m", "month_of_year", "cycle", "ratio", months, th);
  assert.equal(r.status, "cannot_assess");
  assert.equal(r.repeats, 1);
  assert.match(r.reason, /at most 1 occurrence/);
  const single = testCycle("m", "hour_of_day", "cycle", "ratio", [{ slot: "00", instances: 40, num: 10, den: 100, sq: 10 }], th);
  assert.equal(single.status, "cannot_assess");
});

test("totals are tested across occurrences: a quiet weekend is seasonal, steady days are not", () => {
  // per-day totals: weekdays about 1000 (sd 30), weekend about 400
  const rows = (centres: number[]) =>
    centres.map((c, w) => {
      let sum = 0;
      let sq = 0;
      for (let i = 0; i < 12; i++) {
        const t = c + ((i * 37 + w * 11) % 7) * 10 - 30;
        sum += t;
        sq += t * t;
      }
      return { slot: String(w), instances: 12, num: sum, den: 100000, sq };
    });
  assert.equal(testCycle("n", "weekday", "cycle", "sum", rows([1000, 1000, 1000, 1000, 1000, 400, 400]), th).status, "seasonal");
  assert.equal(testCycle("n", "weekday", "cycle", "sum", rows([1000, 1000, 1000, 1000, 1000, 1000, 1000]), th).status, "not_seasonal");
});

// --- the recommendation ----------------------------------------------------------------------------

const ontology = Ontology.parse({
  time: { levels: ["week", "day"], seasonality: "none" },
  hierarchies: { h: ["x"] },
  dimensions: [],
  metrics: { m: { type: "ratio", direction: "higher_is_better" } },
});

const verdict = (cycle: string, status: CycleResult["status"], extra: Partial<CycleResult> = {}): CycleResult => ({
  metric: "m",
  cycle,
  kind: "cycle",
  status,
  reason: "",
  repeats: 12,
  slots: [],
  ...extra,
});

test("the recommendation is the seasonal cycles, the declared calendar flags, and notes for what could not be assessed", () => {
  const a = summarise(ontology, [verdict("weekday", "seasonal", { eta2: 0.1 }), verdict("hour_of_day", "not_seasonal"), verdict("month_of_year", "cannot_assess", { repeats: 1 }), verdict("is_holiday", "cannot_assess", { kind: "calendar", repeats: 1 })]);
  assert.deepEqual(a.recommended.cycles, ["weekday"]);
  assert.deepEqual(a.recommended.calendar, ["is_holiday"]);
  assert.equal(a.recommended.none, false);
  assert.ok(a.notes.some((n) => /month_of_year cannot be assessed/.test(n)));
  assert.ok(a.notes.some((n) => /is_holiday/.test(n)));
});

test("nothing found and no calendar flags records an explicit none", () => {
  const a = summarise(ontology, [verdict("weekday", "not_seasonal")]);
  assert.equal(a.recommended.none, true);
});

test("a half-hour cycle that adds nothing over the hour is dropped as redundant", () => {
  const a = summarise(ontology, [verdict("hour_of_day", "seasonal", { eta2: 0.08 }), verdict("half_hour_of_day", "seasonal", { eta2: 0.085 })]);
  assert.deepEqual(a.recommended.cycles, ["hour_of_day"]);
  assert.ok(a.notes.some((n) => /redundant/.test(n)));
  const finer = summarise(ontology, [verdict("hour_of_day", "seasonal", { eta2: 0.05 }), verdict("half_hour_of_day", "seasonal", { eta2: 0.2 })]);
  assert.deepEqual(finer.recommended.cycles, ["hour_of_day", "half_hour_of_day"]);
});

test("an attribute with many values is a cycle in disguise, not a calendar flag", () => {
  const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ slot: String(i), instances: 12, mean: 0.9 }));
  const a = summarise(ontology, [verdict("weekday", "not_seasonal", { kind: "calendar", slots: slots(7) }), verdict("is_holiday", "not_seasonal", { kind: "calendar", slots: slots(2) })]);
  assert.deepEqual(a.recommended.calendar, ["is_holiday"]);
  assert.ok(a.notes.some((n) => /weekday has 7 distinct values/.test(n)));
});
