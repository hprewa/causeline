import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustedZ, estimateDispersion, NO_DISPERSION, shortfallZ } from "../src/dispersion.js";
import { zScore } from "../src/stats.js";
import type { Bucket } from "../src/types.js";

const bucket = (i: number, num: number, den: number): Bucket => ({ bucket: `p${i}`, bucket_start: `p${i}`, bucket_end: `p${i}`, num, den });
const series = (rows: Array<[number, number]>) => rows.map(([n, d], i) => bucket(i, n, d));

test("steady periods give no extra dispersion; periods that move more than counting noise do", () => {
  const steady = series(Array.from({ length: 10 }, (_, i) => [Math.round(1000 * (0.8 + (i % 2 ? 0.003 : -0.003))), 1000] as [number, number]));
  const wild = series(Array.from({ length: 10 }, (_, i) => [Math.round(1000 * (i % 2 ? 0.9 : 0.7)), 1000] as [number, number]));
  assert.equal(estimateDispersion(steady, 10, "ratio").rho, 0);
  assert.ok(estimateDispersion(wild, 10, "ratio").rho > 0.03);
});

test("with too few earlier periods nothing is adjusted", () => {
  assert.deepEqual(estimateDispersion(series([[5, 10], [6, 10], [4, 10]]), 3, "ratio"), NO_DISPERSION);
});

test("volume that moves more than counting noise is measured, steady volume is not", () => {
  const noisy = series([800, 1200, 900, 1100, 700, 1300, 1000, 850].map((d) => [d / 2, d] as [number, number]));
  const flat = series([1000, 1003, 998, 1001, 999, 1002, 1000, 997].map((d) => [d / 2, d] as [number, number]));
  assert.ok(estimateDispersion(noisy, 8, "ratio").volumeS2 > 0.01);
  assert.equal(estimateDispersion(flat, 8, "ratio").volumeS2, 0);
});

test("with no dispersion the adjusted z-score is the plain one; with dispersion it shrinks", () => {
  const cur = { num: 560, den: 1000 };
  const base = { num: 2000, den: 4000 };
  assert.ok(Math.abs(adjustedZ("ratio", cur, base, 0.25, NO_DISPERSION) - zScore(cur, base)) < 1e-12);
  const adj = adjustedZ("ratio", cur, base, 0.25, { rho: 0.01, s2: 0, volumeS2: 0, history: 10 });
  assert.ok(Math.abs(adj) < Math.abs(zScore(cur, base)));
  assert.equal(Math.sign(adj), Math.sign(zScore(cur, base)));
});

test("a total's z-score also shrinks with relative noise", () => {
  const cur = { num: 1200, den: 100, sq: 1200 };
  const base = { num: 4000, den: 400, sq: 4000 };
  const plain = adjustedZ("sum", cur, base, 0.25, NO_DISPERSION);
  const adj = adjustedZ("sum", cur, base, 0.25, { rho: 0, s2: 0.02, volumeS2: 0, history: 10 });
  assert.ok(plain > 0 && adj > 0 && adj < plain);
});

test("a shortfall must beat the data's own variation to count as missing data", () => {
  assert.ok(shortfallZ(400, 150, NO_DISPERSION) > 4, "counting noise alone: 150 of a usual 400 is far below");
  assert.ok(shortfallZ(400, 150, { ...NO_DISPERSION, volumeS2: 0.25, history: 10 }) < 4, "a node whose volume swings by half is not missing data at 150");
  assert.equal(shortfallZ(0, 0, NO_DISPERSION), 0);
});
