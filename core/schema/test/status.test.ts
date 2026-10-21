import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentDef, atLeast, lowerOf, migrateLegacyStatus, nextRungNeeds, RUNGS, statusSentence } from "../src/index.js";

const base = { name: "x", kpi: "m", task: "deep_rca" };

test("the rungs are ordered and comparable", () => {
  assert.deepEqual([...RUNGS], ["draft", "reconciled", "calibrated", "verified"]);
  assert.ok(atLeast("calibrated", "reconciled") && !atLeast("draft", "reconciled"));
  assert.equal(lowerOf("verified", "reconciled"), "reconciled");
});

test("the earlier names are read with the new meaning", () => {
  assert.deepEqual(migrateLegacyStatus("draft"), { status: "draft", unconfirmed_numbers: false });
  assert.deepEqual(migrateLegacyStatus("provisional"), { status: "draft", unconfirmed_numbers: true });
  assert.deepEqual(migrateLegacyStatus("verified"), { status: "reconciled", unconfirmed_numbers: false });
});

test("an expert file without the ladder marker is migrated; one with it is taken as written", () => {
  const old = AgentDef.parse({ ...base, status: "verified" });
  assert.deepEqual([old.status, old.ladder, old.unconfirmed_numbers], ["reconciled", 2, false]);
  assert.equal(AgentDef.parse({ ...base, status: "provisional" }).unconfirmed_numbers, true);
  assert.equal(AgentDef.parse({ ...base }).status, "draft");
  const fresh = AgentDef.parse({ ...base, status: "verified", ladder: 2 });
  assert.deepEqual([fresh.status, fresh.ladder], ["verified", 2]);
  // writing a migrated expert and reading it again changes nothing
  assert.deepEqual(AgentDef.parse(JSON.parse(JSON.stringify(old))), old);
});

test("every rung has words, and the flag is said for a draft", () => {
  for (const r of RUNGS) assert.ok(statusSentence(r).length > 20);
  assert.match(statusSentence("draft", true), /were not confirmed/);
  assert.doesNotMatch(statusSentence("reconciled", true), /were not confirmed/);
  assert.equal(nextRungNeeds("verified"), "");
  assert.match(nextRungNeeds("draft"), /several numbers/);
});
