import { test } from "node:test";
import assert from "node:assert/strict";
import { Playbook, Result } from "@causeline/schema";
import { loadPlaybook } from "../src/load.js";
import { runPlaybook } from "../src/runner.js";
import { ToolIndex } from "../src/toolindex.js";
import { buildFacts, FakeToolCaller, meta, ontology, type FaultSpec } from "./fake.js";

const handled = loadPlaybook("metric_change", "no-such-pack");
// the handled playbook asks every evidence source ("*"); these tests build the variants by hand
const base = Playbook.parse({ ...handled, steps: handled.steps.filter((x) => !x.evidence) });
const withEvidence = Playbook.parse({ ...base, name: "with_evidence", steps: [...base.steps, { id: "why", evidence: "incidents" }] });

const fault: FaultSpec = { where: (f) => f.week === 5 && f.a2 === "P2" && f.d1 === "Y", okOutOf10: 3 };
const incidents = [
  { a2: "P2", ts: "2026-01-30 10:00:00", kind: "outage" },
  { a2: "Q1", ts: "2026-01-30 11:00:00", kind: "decoy: another node's incident" },
  { a2: "P2", ts: "2026-01-02 09:00:00", kind: "old, outside the period" },
];

async function run(faults: FaultSpec[], playbook = withEvidence) {
  const r = await runPlaybook({ playbook, ontology, meta, tools: new FakeToolCaller(buildFacts(faults), ontology, incidents), inputs: { metric: "m", period: "W5" } });
  assert.doesNotThrow(() => Result.parse(r));
  return r;
}

test("an evidence step asks the source about the culprit the drill found, and nothing else", async () => {
  const r = await run([fault]);
  assert.equal(r.evidence.length, 1);
  const e = r.evidence[0];
  assert.equal(e.source, "incidents");
  assert.deepEqual(e.about, { a2: "P2" }, "the culprit node, not the decoy");
  assert.equal(e.kind, "supporting");
  assert.deepEqual(e.sample.map((x) => x.kind), ["outage"], "the decoy for another node and the record outside the period are not returned");
  assert.equal(e.rows, 1);
  assert.ok(r.steps.some((s) => s.id === "why" && s.tool === "incidents"), "the evidence call is logged like every other");
  // evidence supports a finding; it never becomes one
  assert.ok(r.findings.every((f) => f.dimension !== "kind"));
});

test("with no culprit, the evidence step says why it did not ask, instead of fetching everything", async () => {
  const r = await run([]);
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].rows, 0);
  assert.match(r.evidence[0].skipped ?? "", /no culprit was found for a2/);
});

test("a playbook without an evidence step returns no evidence", async () => {
  assert.deepEqual((await run([fault], base)).evidence, []);
});

test("the tool index finds tools by meaning and explains what is missing", () => {
  const idx = new ToolIndex(meta);
  assert.equal(idx.slice("m", "a2", ["a1"]), "m_by_a2", "one tool per split; a parent is an optional filter");
  assert.equal(idx.series("m", "dy", ["a1"]), "m_series?aggregation=dy", "one series tool; the time level is a bound value");
  assert.throws(() => idx.slice("m", "a2", ["a2"]), /no tool provides/, "a split cannot be confined to itself");
  assert.equal(idx.extent("m"), "m_extent");
  assert.deepEqual(idx.evidenceAbout("incidents"), ["a2"]);
  assert.throws(() => idx.slice("m", "nope"), /no tool provides m split by nope; run `causeline generate`/);
  assert.throws(() => idx.evidence("weather"), /no tool provides evidence weather/);
});

test("the handled metric_change asks every evidence source the pack has, with no playbook of the pack's own", async () => {
  const r = await run([fault], handled);
  assert.deepEqual(r.evidence.map((e) => [e.step, e.source, e.about, e.rows]), [["evidence", "incidents", { a2: "P2" }, 1]]);
  const clean = await run([], handled);
  assert.deepEqual(clean.evidence, [], "nothing found, nothing asked, and no noise about it");
});
