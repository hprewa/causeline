import { test } from "node:test";
import assert from "node:assert/strict";
import { confidenceOf, CEILING } from "../src/confidence.js";

type R = Parameters<typeof confidenceOf>[0]["result"];
const finding = { rank: 1, dimension: "queue", value: "billing", impact: -0.05, evidence: [] };
const strong = (over: Partial<R> = {}): R =>
  ({
    status: "complete",
    stopped_reason: null,
    headline: { significant: true, z: -6 },
    findings: [finding],
    contributions: [{ level: "queue", node: "billing", verdict: "unusual" }],
    masking_flags: [],
    explained: { level: "queue", share: 0.8, unexplained: 0.2 },
    ...over,
  }) as unknown as R;

test("strong evidence from a verified expert is high, with the reasons in words", () => {
  const r = confidenceOf({ rung: "verified", result: strong() });
  assert.equal(r.label, "high");
  assert.equal(r.evidence, "high");
  assert.equal(r.held_back_by, undefined);
  assert.match(r.because.join(" "), /larger than this data's ordinary movement/);
  assert.match(r.because.join(" "), /billing is outside what it has contributed in recent ordinary periods/);
  assert.match(r.because.join(" "), /account for about 80% of the change/);
});

test("the same evidence is held to what the expert's rung allows, and says what would lift it", () => {
  const draft = confidenceOf({ rung: "draft", unconfirmed: true, result: strong() });
  assert.equal(draft.evidence, "high");
  assert.equal(draft.label, "low");
  assert.equal(draft.held_back_by, "draft");
  assert.match(draft.because.at(-1)!, /held to low because the expert is only draft and its numbers were not confirmed against your reports\. To lift it: confirm several numbers/);
  assert.equal(confidenceOf({ rung: "reconciled", result: strong() }).label, "moderate");
  assert.equal(confidenceOf({ rung: "calibrated", result: strong() }).label, "moderate");
  assert.match(confidenceOf({ rung: "calibrated", result: strong() }).because.at(-1)!, /show it finds known incidents/);
});

test("no rung ever gives more than its ceiling, whatever the evidence", () => {
  for (const rung of ["draft", "reconciled", "calibrated", "verified"] as const) {
    const order = ["none", "low", "moderate", "high"];
    assert.ok(order.indexOf(confidenceOf({ rung, result: strong() }).label) <= order.indexOf(CEILING[rung]));
  }
});

test("a part standing out inside a whole that did not change is weaker than a whole that did", () => {
  const flat = confidenceOf({ rung: "verified", result: strong({ headline: { significant: false, z: 0.4 } as never }) });
  assert.equal(flat.label, "high", "a verified expert with a clear part still gets high from two other signals");
  const flatAndUnexplained = confidenceOf({ rung: "verified", result: strong({ headline: { significant: false, z: 0.4 } as never, explained: { level: "queue", share: 0.1, unexplained: 0.9 } }) });
  assert.equal(flatAndUnexplained.label, "low");
  assert.match(flatAndUnexplained.because.join(" "), /did not change by more than the data's ordinary movement/);
  assert.match(flatAndUnexplained.because.join(" "), /only about 10% of the change; most of it is not explained/);
});

test("a node that always contributes this much, or thin data at its level, lowers the evidence", () => {
  const usual = confidenceOf({ rung: "verified", result: strong({ contributions: [{ level: "queue", node: "billing", verdict: "usual" }] as never }) });
  assert.equal(usual.evidence, "moderate");
  assert.match(usual.because.join(" "), /contributes about what it usually does/);
  const thin = confidenceOf({ rung: "verified", result: strong({ contributions: [], masking_flags: [{ level: "queue", type: "small_cells" }] as never }) });
  assert.equal(thin.evidence, "moderate");
  assert.match(thin.because.join(" "), /Some queue values were too small to judge/);
  assert.match(thin.because.join(" "), /billing was not checked against its own history/);
});

test("an answer that finds nothing can only say it found nothing", () => {
  const none = confidenceOf({ rung: "verified", result: strong({ findings: [], headline: { significant: false, z: 0.1 } as never }) });
  assert.equal(none.label, "moderate");
  assert.match(none.because[0], /does not show that nothing happened/);
  assert.equal(confidenceOf({ rung: "draft", result: strong({ findings: [] }) }).label, "low");
});

test("a declined analysis and an exploratory answer are not rated", () => {
  const stopped = confidenceOf({ rung: "verified", result: { status: "stopped", stopped_reason: "data_quality", headline: null, findings: [], contributions: [], masking_flags: [] } as never });
  assert.equal(stopped.label, "none");
  assert.match(stopped.because[0], /declined to answer \(data quality\)/);
  const exploratory = confidenceOf({ rung: "exploratory", result: strong() });
  assert.equal(exploratory.label, "none");
  assert.match(exploratory.because[0], /exploratory answer/);
});
