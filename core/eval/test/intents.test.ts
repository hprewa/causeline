import { test } from "node:test";
import assert from "node:assert/strict";
import type { IntentCheck } from "@causeline/schema";
import { scoreIntent } from "../src/intents.js";

const ready: IntentCheck = {
  status: "ready",
  playback: "A deep dive into service level for last week (9–15 March 2026).",
  notes: [],
  resolved: { kpi: "service_level", task: "deep_rca", window: { start: "2026-03-09", end: "2026-03-15", days: 7, description: "last week" }, aggregation: "", filters: { team: "team_05" } },
};
const asked: IntentCheck = { status: "ask", slot: "period", question: "Which period?", options: [{ value: "last week", label: "last week" }] };

test("an intent that matches every expectation has no misses", () => {
  assert.deepEqual(scoreIntent(ready, { status: "ready", kpi: "service_level", window: { start: "2026-03-09", end: "2026-03-15" }, filters: { team: "team_05" }, says: ["deep dive"] }), []);
  assert.deepEqual(scoreIntent(asked, { status: "ask", slot: "period", offers: ["last week"] }), []);
});

test("each way an intent can be wrong is a miss that names it", () => {
  const miss = (check: IntentCheck, e: Parameters<typeof scoreIntent>[1]) => scoreIntent(check, e).join(" | ");
  assert.match(miss(ready, { status: "ask" }), /status: expected "ask", got "ready"/);
  assert.match(miss(ready, { status: "ready", window: { start: "2026-03-02", end: "2026-03-08" } }), /window/);
  assert.match(miss(ready, { status: "ready", filters: {} }), /filters/);
  assert.match(miss(ready, { status: "ready", says: ["yesterday"] }), /play-back does not say "yesterday"/);
  assert.match(miss(asked, { status: "ask", slot: "kpi" }), /slot/);
  assert.match(miss(asked, { status: "ask", offers: ["last month"] }), /does not offer "last month"/);
  assert.match(miss(asked, { status: "ready" }), /status/);
});
