import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@causeline/schema";
import { aggregateInto, candidateNodes, effectOf, MAX_NODES, verdictOf } from "../src/contributions.js";
import { decomposeRatio } from "../src/decompose.js";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import type { Bucket } from "../src/types.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const c = (num: number, den: number) => ({ num, den });

test("a node's contribution to a ratio is decomposeRatio's, and a partition adds up exactly to the change", () => {
  const nodes = [
    { cur: c(90, 100), base: c(380, 400) },
    { cur: c(40, 100), base: c(300, 400) },
    { cur: c(45, 50), base: c(180, 200) },
  ];
  const parentCur = c(175, 250);
  const parentBase = c(860, 1000);
  const effects = nodes.map((n) => effectOf("ratio", parentCur, parentBase, n.cur, n.base, 4));
  const total = effects.reduce((a, e) => a + e.contribution, 0);
  assert.ok(Math.abs(total - effects[0].change) < 1e-12, "contributions add up to the change");
  const d = decomposeRatio(nodes.map((n, i) => ({ node: String(i), cur: n.cur, base: n.base })))!;
  nodes.forEach((_, i) => {
    assert.ok(Math.abs(d.children[i].contribution - effects[i].contribution) < 1e-12);
    assert.ok(Math.abs(d.children[i].rateEffect - effects[i].rate) < 1e-12);
    assert.ok(Math.abs(d.children[i].mixEffect - effects[i].mix) < 1e-12);
  });
});

test("a node's contribution to a total is its amount less its share of the baseline's average period", () => {
  const e = effectOf("sum", c(1500, 1500), c(4000, 4000), c(700, 700), c(1600, 1600), 4);
  assert.equal(e.change, 500);
  assert.equal(e.contribution, 300);
});

test("verdicts: usual when it always contributes about this much, unusual when outside its history, new without a baseline, unknown with little history", () => {
  const history = [-0.1, 0.2, 0.0, 0.1, -0.2, 0.1, 0.0, -0.1];
  assert.equal(verdictOf(0.05, history, 500, 30).verdict, "usual");
  assert.equal(verdictOf(0.25, history, 500, 30).verdict, "usual", "outside the range by a little is not unusual: the margin is robust standard deviations");
  const big = verdictOf(-1.8, history, 500, 30);
  assert.equal(big.verdict, "unusual");
  assert.ok(Math.abs((big.delta ?? 0) + 1.8) < 0.1);
  assert.equal(verdictOf(-1.8, history, 3, 30).verdict, "new", "under min_volume rows a period in the baseline");
  assert.equal(verdictOf(-1.8, [0, 0.1, -0.1], 500, 30).verdict, "unknown");
  assert.equal(verdictOf(1, [], 500, 30).verdict, "unknown");
});

test("a node's day-level rows are summed into the parent's periods by the timestamps they span", () => {
  const p = (bucket: string, s: string, e: string): Bucket => ({ bucket, bucket_start: s, bucket_end: e, num: 0, den: 0 });
  const parents = [p("W1", "2026-01-01 00:00:00", "2026-01-07 23:00:00"), p("W2", "2026-01-08 00:00:00", "2026-01-14 23:00:00")];
  const row = (day: string, num: number, den: number): Bucket => ({ bucket: day, bucket_start: `${day} 09:00:00`, bucket_end: `${day} 17:00:00`, num, den });
  const out = aggregateInto(parents, [row("2026-01-02", 1, 2), row("2026-01-07", 2, 3), row("2026-01-09", 5, 7), row("2026-02-01", 9, 9)]);
  assert.deepEqual(out, [c(3, 5), c(5, 7)], "a row outside every period is dropped");
});

test("candidates are the biggest contributors in the change's direction, each a tenth of the change or more, a handful in all", () => {
  const child = (node: string, contribution: number, share: number | null) => ({ node, contribution, share }) as never;
  const look = (concept: string, change: number, children: unknown[]) => ({ concept, decomposition: { parent: { change }, children } }) as never;
  const picked = candidateNodes([
    look("a", 10, [child("big", 6, 0.6), child("mid", 2.5, 0.25), child("small", 0.5, 0.05), child("against", -3, -0.3)]),
    look("b", 10, [child("big", 6, 0.6), ...Array.from({ length: 8 }, (_, i) => child(`n${i}`, 1.1 + i * 0.01, 0.11))]),
  ]);
  assert.ok(picked.length <= MAX_NODES);
  assert.deepEqual(picked.filter((x) => x.level === "a").map((x) => x.node), ["big", "mid"], "the small one and the one against the change are left out");
  assert.equal(candidateNodes([look("a", 0, [child("x", 1, null)])]).length, 0, "nothing to attribute when the whole did not change");
});

// --- through the runner -----------------------------------------------------------------------------------------------

const playbook = loadPlaybook("metric_change", "no-such-pack");
const without = { ...playbook, steps: playbook.steps.filter((s) => s.id !== "contributions") };

async function run(faults: FaultSpec[], period: string, weeks: number, pb = playbook) {
  const result = await runPlaybook({ playbook: pb, ontology, meta, tools: new FakeToolCaller(buildFacts(faults, weeks)), inputs: { metric: "m", period } });
  assert.doesNotThrow(() => Result.parse(result));
  return result;
}

test("planted fault: its node is reported as an unusual contributor, with its history, and the findings are the same as without the step", async () => {
  const fault: FaultSpec[] = [{ where: (f) => f.week === 10 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 }];
  const r = await run(fault, "W10", 12);
  const plain = await run(fault, "W10", 12, without);
  assert.deepEqual(r.findings, plain.findings, "the step changes no finding");
  assert.deepEqual(r.path, plain.path);
  assert.ok(r.contributions.length > 0 && r.contributions.length <= MAX_NODES);
  const y = r.contributions.find((x) => x.level === "d1" && x.node === "Y");
  assert.ok(y, `contributors: ${r.contributions.map((x) => `${x.level}=${x.node}`).join(", ")}`);
  assert.equal(y.verdict, "unusual");
  assert.ok(y.history && y.history.periods >= 4 && y.history.periods <= 8, JSON.stringify(y.history));
  assert.ok(y.contribution < 0 && (y.share ?? 0) > 0.1);
  assert.ok(Math.abs((y.rate_effect ?? 0) + (y.mix_effect ?? 0) - y.contribution) < 1e-5, "rate and mix add up to the contribution");
  assert.ok(r.explained && r.explained.share > 0.2 && Math.abs(r.explained.share + r.explained.unexplained - 1) < 1e-6);
  // one query per node reported
  assert.ok(r.steps.filter((s) => s.id === "contributions").length <= MAX_NODES);
});

test("clean data: nothing is reported as unusual or new", async () => {
  const r = await run([], "W10", 12);
  assert.ok(r.contributions.every((x) => x.verdict !== "unusual" && x.verdict !== "new"), JSON.stringify(r.contributions.map((x) => [x.level, x.node, x.verdict])));
});

test("with too few earlier periods the verdict is unknown, not a guess", async () => {
  const r = await run([{ where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 }], "W5", 6);
  const y = r.contributions.find((x) => x.level === "d1" && x.node === "Y");
  assert.ok(y);
  assert.ok(y.history === null || y.history.periods < 4);
  assert.equal(y.verdict, "unknown");
});

test("a total (volume) is attributed the same way", async () => {
  const fault: FaultSpec[] = [{ where: (f) => f.week === 10 && f.a2 === "Q1", okOutOf10: 9, extraOutOf10: 6 }];
  const r = await runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(fault, 12)), inputs: { metric: "n_rows", period: "W10" } });
  const top = r.contributions[0];
  assert.ok(top, "a contributor is reported");
  assert.ok(top.contribution > 0 && top.verdict === "unusual", JSON.stringify(top));
});
