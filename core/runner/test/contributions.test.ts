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

// --- reporting contributors (sprint 3 step 3) ----------------------------------------------------------------------------

import { CONCENTRATION, PER_LEVEL, selectContributors } from "../src/contributions.js";
import type { Contribution } from "@causeline/schema";

const contrib = (level: string, node: string, share: number, baselineShare: number, verdict: Contribution["verdict"] = "unusual"): Contribution => ({
  level,
  node,
  contribution: share * 100,
  share,
  rate_effect: share * 100,
  mix_effect: 0,
  volume: 1000,
  baseline_volume: 500,
  baseline_share: baselineShare,
  history: { periods: 8, typical: 0, low: -1, high: 1 },
  delta_vs_typical: share * 100,
  verdict,
});
const draft = (dimension: string, scope?: Record<string, string>) => ({ dimension, value: "x", impact: 1, evidence: ["where"], ...(scope ? { scope } : {}) });
const hier = { org: ["centre", "site"], line: ["product", "subproduct"] };

test("a contributor is a node carrying a quarter of a real change, well beyond its size, that is new or unusual, in a concept nothing explained yet", () => {
  const picked = selectContributors([contrib("company", "big", 0.45, 0.05), contrib("company", "ordinary", 0.3, 0.28), contrib("company", "usual", 0.4, 0.05, "usual"), contrib("company", "small", 0.1, 0.01), contrib("company", "fresh", 0.3, 0.0, "new")], [], hier, true, 0.25);
  assert.deepEqual(picked.map((c) => c.node), ["big", "fresh"], "the big one (45%, nine times its size) and the new one; not the node that is just big, the usual one, or the small share");
  assert.ok(CONCENTRATION > 1);
});

test("no contributors when the change is not real, and none in a concept a finding already explains", () => {
  const all = [contrib("company", "a", 0.5, 0.05), contrib("centre", "cc_1", 0.6, 0.1), contrib("subproduct", "p", 0.5, 0.05), contrib("state", "ca", 0.4, 0.05)];
  assert.deepEqual(selectContributors(all, [], hier, false, 0.25), [], "the change is within normal variation");
  const picked = selectContributors(all, [draft("company"), draft("site"), draft("product", { state: "ca" })], hier, true, 0.25).map((c) => `${c.level}=${c.node}`);
  assert.deepEqual(picked, [], "company has a finding; a finding on site covers centre; a finding on product covers subproduct; a scoped finding covers its scope's concept");
  assert.deepEqual(selectContributors(all, [draft("company")], hier, true, 0.25).map((c) => c.level).sort(), ["centre", "state", "subproduct"]);
});

test("at most three contributors for one level, the biggest first", () => {
  const many = Array.from({ length: 6 }, (_, i) => contrib("company", `c${i}`, 0.3 + i * 0.01, 0.02));
  const picked = selectContributors(many, [], hier, true, 0.25);
  assert.equal(picked.length, PER_LEVEL);
  assert.deepEqual(picked.map((c) => c.node), ["c5", "c4", "c3"]);
});

test("through the runner: a flat dimension where no value dominates reports its biggest contributor, as a contributor", async () => {
  // d1=Y gets half again its volume, the other two a fifth: Y carries 56% of the rise (under the drill share), the hierarchies see nothing concentrated
  const fault: FaultSpec[] = [{ where: (f) => f.week === 10 && f.d1 === "Y", okOutOf10: 9, extraOutOf10: 5 }, { where: (f) => f.week === 10 && f.d1 !== "Y", okOutOf10: 9, extraOutOf10: 2 }];
  const withIt = await runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(fault, 12)), inputs: { metric: "n_rows", period: "W10" } });
  const plain = await runPlaybook({ playbook: { ...playbook, steps: playbook.steps.filter((s) => s.id !== "contributors") }, ontology, meta, tools: new FakeToolCaller(buildFacts(fault, 12)), inputs: { metric: "n_rows", period: "W10" } });
  assert.ok(!plain.findings.some((f) => f.dimension === "d1"), "without the step nothing is reported for d1 (no value reaches the drill share)");
  const y = withIt.findings.find((f) => f.dimension === "d1" && f.value === "Y");
  assert.ok(y, JSON.stringify(withIt.findings.map((f) => [f.dimension, f.value, f.role])));
  assert.equal(y.role, "contributor");
  assert.ok(y.impact > 0);
  assert.deepEqual(plain.findings, withIt.findings.filter((f) => f.role !== "contributor").map((f, i) => ({ ...f, rank: i + 1 })), "the other findings are untouched apart from their rank");
});

test("through the runner: a rise spread evenly over every node reports no contributor", async () => {
  const fault: FaultSpec[] = [{ where: (f) => f.week === 10, okOutOf10: 9, extraOutOf10: 3 }];
  const r = await runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(fault, 12)), inputs: { metric: "n_rows", period: "W10" } });
  assert.ok(r.headline!.significant);
  assert.ok(!r.findings.some((f) => f.role === "contributor"), JSON.stringify(r.findings.map((f) => [f.dimension, f.value, f.role])));
});
