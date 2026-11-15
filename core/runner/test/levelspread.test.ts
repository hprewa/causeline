import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustedZ } from "../src/dispersion.js";
import { MIN_SPREAD_PERIODS, PRIOR_PERIODS, rawExcess, shrinkSpreads } from "../src/levelspread.js";
import type { Components } from "../src/types.js";

/** A small deterministic generator, so the tests draw the same numbers every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const gauss = (u: () => number) => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());

/** `periods` weekly rates of `n` rows around `p`, each week shifted by a normal with this sd, plus binomial counting noise (normal approximation). */
function rateSeries(u: () => number, periods: number, n: number, p: number, sd: number): Components[] {
  return Array.from({ length: periods }, () => {
    const week = p + sd * gauss(u);
    const num = Math.round(n * week + Math.sqrt(n * week * (1 - week)) * gauss(u));
    return { num, den: n };
  });
}

test("a part's excess spread is about its wobble squared over p(1-p), and about zero for counting noise alone", () => {
  const u = rng(7);
  const p = 0.8;
  const wobbling = Array.from({ length: 200 }, () => rawExcess(rateSeries(u, 12, 1000, p, 0.02), "ratio")!.excess);
  const steady = Array.from({ length: 200 }, () => rawExcess(rateSeries(u, 12, 1000, p, 0), "ratio")!.excess);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const expected = 0.02 ** 2 / (p * (1 - p));
  assert.ok(Math.abs(mean(wobbling) - expected) < expected * 0.2, `mean excess ${mean(wobbling)} against ${expected}`);
  assert.ok(Math.abs(mean(steady)) < expected * 0.1, `steady parts average ${mean(steady)}`);
});

test("too few periods give no estimate", () => {
  const u = rng(1);
  assert.equal(rawExcess(rateSeries(u, MIN_SPREAD_PERIODS - 1, 1000, 0.8, 0.02), "ratio"), null);
  assert.equal(shrinkSpreads(new Map([["a", rateSeries(u, MIN_SPREAD_PERIODS - 1, 1000, 0.8, 0.02)]]), "ratio", MIN_SPREAD_PERIODS - 1), null);
});

test("a part whose five weeks happened to be steady is still judged by what its siblings show", () => {
  const u = rng(3);
  const history = new Map<string, Components[]>();
  for (let i = 0; i < 11; i++) history.set(`team_${i}`, rateSeries(u, 5, 1000, 0.8, 0.02));
  // one team with five identical weeks: on its own it would look as if it never moves
  history.set("steady", Array.from({ length: 5 }, () => ({ num: 800, den: 1000 })));
  const spread = shrinkSpreads(history, "ratio", 5)!;
  assert.ok(spread.level > 0);
  const own = rawExcess(history.get("steady")!, "ratio")!;
  assert.ok(own.excess < 0, "its own excess is below counting noise");
  const rho = spread.of("steady").rho;
  // pulled most of the way to the level: 4 periods of its own against PRIOR_PERIODS of the level's
  const expected = Math.max(0, (4 * own.excess + PRIOR_PERIODS * spread.level) / (4 + PRIOR_PERIODS));
  assert.ok(Math.abs(rho - expected) < 1e-12);
  assert.ok(rho > spread.level * 0.5, `rho ${rho} against the level's ${spread.level}`);
  // a 5-point move in that team: far out on counting noise, ordinary on the spread it is judged by
  const cur = { num: 750, den: 1000 };
  const base = { num: 3200, den: 4000 };
  assert.ok(Math.abs(adjustedZ("ratio", cur, base, 1 / 4, { rho: 0, s2: 0, volumeS2: 0, history: 0 })) > 3.3);
  assert.ok(Math.abs(adjustedZ("ratio", cur, base, 1 / 4, spread.of("steady"))) < 3);
});

test("a part with a long history of its own keeps most of its own spread, and a part never seen gets the level's", () => {
  const u = rng(11);
  const history = new Map<string, Components[]>();
  for (let i = 0; i < 8; i++) history.set(`calm_${i}`, rateSeries(u, 12, 2000, 0.8, 0.005));
  history.set("wild", rateSeries(u, 12, 2000, 0.8, 0.06));
  const spread = shrinkSpreads(history, "ratio", 12)!;
  assert.ok(spread.of("wild").rho > 3 * spread.of("calm_0").rho, "the volatile part is judged by a wider spread than its calm siblings");
  assert.equal(spread.of("never_seen").rho, spread.level);
});

test("counting noise is the floor: steady parts get no extra spread, never a negative one", () => {
  const u = rng(5);
  const history = new Map<string, Components[]>();
  for (let i = 0; i < 12; i++) history.set(`t${i}`, rateSeries(u, 8, 1000, 0.8, 0));
  const spread = shrinkSpreads(history, "ratio", 8)!;
  for (const node of history.keys()) assert.ok(spread.of(node).rho >= 0);
  assert.ok(spread.level < 0.02 ** 2 / 0.16 / 4, `level ${spread.level} is small for steady data`);
});

test("totals: the excess is the squared relative wobble", () => {
  const u = rng(9);
  const series = (sd: number): Components[] =>
    Array.from({ length: 12 }, () => {
      const n = Math.max(1, Math.round(1000 * (1 + sd * gauss(u)) + Math.sqrt(1000) * gauss(u)));
      return { num: n, den: n, sq: n };
    });
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const wobbling = mean(Array.from({ length: 200 }, () => rawExcess(series(0.08), "sum")!.excess));
  assert.ok(Math.abs(wobbling - 0.08 ** 2) < 0.08 ** 2 * 0.25, `mean excess ${wobbling} against ${0.08 ** 2}`);
});
