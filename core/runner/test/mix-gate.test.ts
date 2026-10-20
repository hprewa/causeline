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

test("a node carrying the change is the culprit even when thin nodes inflate the rate and mix totals", { todo: "the mix gate fires on a mix total that opposes the change and picks its culprit by mix effect (names a thin node); fixed in sprint 3 step 4" }, () => {
  const d = decomposeRatio(incident());
  const decision = decideLevel(d, { minVolume: 30, direction: "higher_is_better", th: DEFAULT_THRESHOLDS });
  assert.equal(decision.culprit, "big_mover");
});
