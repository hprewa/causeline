import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { branchCoverage, expertsWithUntestedBranches, renderCoverage } from "../src/branches.js";
import type { CaseOutcome } from "../src/table.js";

const pack = resolve("..", "..", "packs", "contact-centre");
const ok = (id: string, branches: string[], extra: Partial<CaseOutcome> = {}): CaseOutcome => ({ id, playbook: "metric_change", branches, runner: { pass: true, checks: [] }, runnerMs: 0, steps: 0, ...extra });

test("a hand-off branch is not applicable to a pack whose KPIs have no parts", () => {
  const complaints = resolve("..", "..", "packs", "complaints");
  const [c] = branchCoverage([ok("a", [])], complaints);
  assert.deepEqual(c.notApplicable, ["parts:when:run"]);
  assert.ok(!c.untested.includes("parts:when:run"));
  assert.match(renderCoverage([c], []), /not applicable to this pack: parts:when:run/);
});

test("branches taken by passing cases are covered; the rest are listed as untested", () => {
  const [c] = branchCoverage([ok("a", ["contributors:when:run", "parts:when:skipped"])], pack);
  assert.equal(c.playbook, "metric_change");
  assert.deepEqual(c.covered, ["contributors:when:run", "parts:when:skipped"]);
  assert.deepEqual(c.untested, ["contributors:when:skipped", "parts:when:run"]);
});

test("a failing case or a known gap proves nothing", () => {
  const failing = ok("f", ["parts:when:run"], { runner: { pass: false, checks: [] } });
  const gapped = ok("g", ["parts:when:run"], { gap: "why" });
  const [c] = branchCoverage([failing, gapped], pack);
  assert.ok(c.untested.includes("parts:when:run"));
});

test("an expert above draft whose playbook has an untested branch is flagged", () => {
  const coverage = branchCoverage([ok("a", ["contributors:when:run"])], pack);
  const flagged = expertsWithUntestedBranches(coverage, pack);
  assert.ok(flagged.some((f) => f.expert === "service-level-deep-rca"));
  assert.match(renderCoverage(coverage, flagged), /stands as reconciled/);
  const full = branchCoverage([ok("a", ["contributors:when:run", "contributors:when:skipped", "parts:when:run", "parts:when:skipped"])], pack);
  assert.deepEqual(expertsWithUntestedBranches(full, pack), []);
});
