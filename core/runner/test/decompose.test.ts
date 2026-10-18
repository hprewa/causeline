import { test } from "node:test";
import assert from "node:assert/strict";
import { decomposeRatio, decomposeAgainstBaseline } from "../src/decompose.js";
import type { ChildRow } from "../src/types.js";

const close = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("contributions sum exactly to the parent's change, including a child new in the current window", () => {
  const rows: ChildRow[] = [
    { node: "a", cur: { num: 90, den: 100 }, base: { num: 380, den: 400 } },
    { node: "b", cur: { num: 60, den: 100 }, base: { num: 190, den: 200 } },
    { node: "new", cur: { num: 40, den: 50 }, base: { num: 0, den: 0 } },
    { node: "gone", cur: { num: 0, den: 0 }, base: { num: 70, den: 100 } },
  ];
  const d = decomposeRatio(rows)!;
  const total = d.children.reduce((s, c) => s + c.contribution, 0);
  close(total, d.parent.change);
  close(d.rateTotal + d.mixTotal, d.parent.change);
  // a child absent from the baseline contributes no mix, only rate
  assert.equal(d.children.find((c) => c.node === "new")!.mixEffect, 0);
});

test("pure mix: unchanged child rates, volume moves to the worse child", () => {
  const d = decomposeRatio([
    { node: "x", cur: { num: 190, den: 200 }, base: { num: 760, den: 800 } }, // 0.95
    { node: "y", cur: { num: 640, den: 800 }, base: { num: 160, den: 200 } }, // 0.80
  ])!;
  close(d.parent.baseRate, 0.92);
  close(d.parent.curRate, 0.83);
  close(d.rateTotal, 0);
  close(d.mixTotal, -0.09);
  close(d.children.find((c) => c.node === "y")!.mixEffect, -0.072);
});

test("Simpson's paradox: every child improves, the total drops", () => {
  const d = decomposeRatio([
    { node: "x", cur: { num: 184, den: 200 }, base: { num: 720, den: 800 } }, // 0.90 -> 0.92
    { node: "y", cur: { num: 480, den: 800 }, base: { num: 100, den: 200 } }, // 0.50 -> 0.60
  ])!;
  close(d.parent.change, -0.156);
  assert.ok(d.rateTotal > 0, "children improved");
  close(d.rateTotal, 0.084);
  close(d.mixTotal, -0.24);
});

test("returns null when a window is empty", () => {
  assert.equal(decomposeRatio([{ node: "a", cur: { num: 0, den: 0 }, base: { num: 1, den: 2 } }]), null);
});

test("against a pooled baseline there is no mix and contributions still sum to the change", () => {
  const d = decomposeAgainstBaseline(
    [
      { node: "t1", cur: { num: 90, den: 100 } },
      { node: "t2", cur: { num: 50, den: 100 } },
    ],
    { num: 930, den: 1000 },
  )!;
  assert.equal(d.mixTotal, 0);
  close(d.children.reduce((s, c) => s + c.contribution, 0), d.parent.change);
  close(d.parent.change, 0.7 - 0.93);
});
