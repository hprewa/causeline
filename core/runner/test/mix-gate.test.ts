import { test } from "node:test";
import assert from "node:assert/strict";
import { decomposeRatio } from "../src/decompose.js";
import { DEFAULT_THRESHOLDS, decideLevel } from "../src/masking.js";
import type { ChildRow } from "../src/types.js";

const row = (node: string, cn: number, cd: number, bn: number, bd: number): ChildRow => ({ node, cur: { num: cn, den: cd }, base: { num: bn, den: bd } });

/**
 * The shape of a real incident (a week in which most of the volume moved to one company that answers on time, among hundreds of
 * companies, most of them with a handful of rows in the baseline). A node with three baseline rows has a baseline rate of 0% or
 * 100% by chance, so its rate effect and its mix effect are each large and cancel; added up over the many thin nodes they make the
 * mix total big and OPPOSITE to the change, and the mix gate then names the node with the largest mix effect (a thin one), not the
 * node that carries the change.
 */
function incident(): ChildRow[] {
  const rows = [row("big_mover", 5723, 5723, 1971, 2032), row("normal_a", 1450, 1500, 7800, 8000), row("normal_b", 880, 900, 4900, 5000), row("normal_c", 640, 660, 3500, 3600)];
  for (let i = 0; i < 60; i++) rows.push(row(`thin_${i}`, 38, 40, i % 2 === 0 ? 3 : 0, 3));
  return rows;
}

test("the fixture has the incident's shape: rate and mix totals far larger than the change and of opposite sign, one node carrying the change", () => {
  const d = decomposeRatio(incident())!;
  assert.ok(d.parent.change > 0 && d.rateTotal > 5 * d.parent.change && d.mixTotal < -5 * d.parent.change, `rate ${d.rateTotal}, mix ${d.mixTotal}, change ${d.parent.change}`);
  const top = [...d.children].sort((a, b) => b.contribution - a.contribution)[0];
  assert.equal(top.node, "big_mover");
  assert.ok((top.share ?? 0) > 1, "it carries more than all of the change");
});

test("a node carrying the change is the culprit even when thin nodes would inflate the rate and mix totals", () => {
  const d = decomposeRatio(incident(), { thinBelow: 30 });
  const decision = decideLevel(d, { minVolume: 30, direction: "higher_is_better", th: DEFAULT_THRESHOLDS });
  assert.equal(decision.decision, "drill");
  assert.equal(decision.culprit, "big_mover");
});

test("thin baselines no longer inflate the split: the totals are of the order of the change, and contributions still add up", () => {
  const d = decomposeRatio(incident(), { thinBelow: 30 })!;
  assert.ok(Math.abs(d.rateTotal) < 3 * Math.abs(d.parent.change) && Math.abs(d.mixTotal) < 3 * Math.abs(d.parent.change), `rate ${d.rateTotal}, mix ${d.mixTotal}, change ${d.parent.change}`);
  assert.ok(Math.abs(d.children.reduce((a, c) => a + c.contribution, 0) - d.parent.change) < 1e-12);
  const thin = d.children.find((c) => c.node === "thin_1")!;
  assert.equal(thin.mixEffect, 0, "a thin node takes the whole's baseline rate, so it has no mix effect");
});

test("a change in the mix that points against the change is not called mix", () => {
  // both children improved a lot and volume moved toward the worse one: the whole rose, the mix total is negative
  const rows = [row("a", 380, 400, 640, 800), row("b", 540, 600, 100, 200)];
  const d = decomposeRatio(rows)!;
  assert.ok(d.parent.change > 0 && d.mixTotal < 0, `change ${d.parent.change}, mix ${d.mixTotal}`);
  const decision = decideLevel(d, { minVolume: 30, direction: "higher_is_better", th: DEFAULT_THRESHOLDS });
  assert.notEqual(decision.effect, "mix");
});
