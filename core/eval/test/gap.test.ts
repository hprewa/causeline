import { test } from "node:test";
import assert from "node:assert/strict";
import { EvalCase } from "@causeline/schema";
import { renderTable, runnerOk, type CaseOutcome } from "../src/table.js";

const outcome = (id: string, pass: boolean, gap?: string): CaseOutcome => ({ id, ...(gap ? { gap } : {}), runner: { pass, checks: [{ name: "top_finding", ok: pass, detail: "expected a=b" }] }, runnerMs: 1, steps: 1 });

test("a case with a gap marker is accepted while it fails and rejected once it passes", () => {
  assert.equal(runnerOk(outcome("a", true)), true);
  assert.equal(runnerOk(outcome("b", false)), false);
  assert.equal(runnerOk(outcome("c", false, "not found yet")), true, "an open gap does not fail the run");
  assert.equal(runnerOk(outcome("d", true, "not found yet")), false, "a closed gap must have its marker removed");
  assert.equal(runnerOk({ id: "e", gap: "x", runner: { error: "boom" }, runnerMs: 0, steps: 0 }), false, "an error is never a known gap");
});

test("the table counts known gaps apart from the score, and says when one has closed", () => {
  const text = renderTable([outcome("a", true), outcome("b", false, "needs contributions"), outcome("c", true, "needs mix attribution")], false);
  assert.match(text, /^b\s+gap\b/m);
  assert.match(text, /^c\s+GAP CLOSED\b/m);
  assert.match(text, /runner score: 1\/1 \(and 2 known gaps, 1 still open\)/);
  assert.match(text, /gap c: needs mix attribution {2}<- it passes now: remove the gap marker/);
  assert.ok(!/b \[runner\] top_finding/.test(text), "an open gap's failing checks are not listed as failures");
});

test("a case file may carry a gap marker", () => {
  const c = EvalCase.parse({ id: "x", question: "q", expect: { no_findings: true }, gap: "the analysis reports changes that cancel out" });
  assert.equal(c.gap, "the analysis reports changes that cancel out");
  assert.equal(EvalCase.safeParse({ id: "x", question: "q", expect: { no_findings: true }, gap: "" }).success, false);
});
