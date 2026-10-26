import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrate, newState, updateState, writeState } from "@causeline/builder";
import type { Result } from "@causeline/schema";
import { calibrationStatusTool, describeCalibration, labelPeriodTool } from "../src/handlers.js";
import type { ServerConfig } from "../src/config.js";

const loud = { status: "complete", headline: { z: 5, significant: true }, findings: [], masking_flags: [] } as unknown as Result;
const quiet = { status: "complete", headline: { z: 0, significant: false }, findings: [], masking_flags: [] } as unknown as Result;
const weeks = Array.from({ length: 16 }, (_, i) => ({ bucket: `2026-W${String(i + 1).padStart(2, "0")}`, bucket_start: new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10), bucket_end: new Date(Date.UTC(2026, 0, 11 + i * 7)).toISOString().slice(0, 10), num: 1, den: 1 }));

async function replayed(says: Record<string, Result>) {
  const ws = mkdtempSync(join(tmpdir(), "calibrate-tools-"));
  writeState(ws, newState("x"));
  updateState(ws, (st) => {
    const check = (kind: "total" | "slice" | "grain", start: string, end: string) => ({ id: `${kind}-1`, kind, scope: {}, window: { start, end }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" as const });
    st.kpis.ok = { level: "reconciled", checks: [check("total", "2026-01-05", "2026-01-11"), check("slice", "2026-01-05", "2026-01-11"), check("grain", "2026-01-12", "2026-01-12")], auto: { at: "now", pass: true, results: [] } };
  });
  const deps = { baseline: 4, key: () => "k", periods: async () => weeks, runOne: async (b: { bucket: string }) => ({ result: says[b.bucket] ?? quiet }) };
  const report = await calibrate({ workspace: ws, kpi: "ok", makeTools: async () => ({}) as never, deps });
  return { ws, cfg: { packDir: ws } as ServerConfig, report };
}

test("a pass is said with the tool's own numbers and the honest upper end", async () => {
  const { report } = await replayed({});
  const d = describeCalibration(report) as { say: string; next: string };
  assert.match(d.say, /Of the 12 ordinary periods I could judge, 0 raised something \(none\)\. You allow about 1 in 20\./);
  assert.match(d.say, /calibrated/);
  assert.match(d.say, /could still be as high as about 1 in 4/);
});

test("a fail lists the weeks to ask about one at a time, and a label moves the result", async () => {
  const { cfg, report } = await replayed({ "2026-W07": loud, "2026-W09": loud });
  const d = describeCalibration(report) as { say: string; next: string; flagged: unknown[] };
  assert.match(d.say, /2 raised something \(about 1 in 6\)/);
  assert.match(d.say, /stays reconciled/);
  assert.match(d.next, /ONE AT A TIME/);
  assert.equal(d.flagged.length, 2);
  const a = labelPeriodTool(cfg, { kpi: "ok", period: "2026-W07", real: true, note: "an outage" });
  assert.match(a.say, /no longer counts against the KPI/);
  assert.match(a.next, /1 flagged period is still unanswered/);
  const b = labelPeriodTool(cfg, { kpi: "ok", period: "2026-W09", real: false });
  assert.match(b.say, /still counts as a false alarm/);
  assert.match(b.next, /call calibrate again/);
  const s = calibrationStatusTool(cfg, { kpi: "ok" }) as { say: string; known_events: { note?: string }[] };
  assert.match(s.say, /1 of 11 ordinary periods raised something/);
  assert.equal(s.known_events[0].note, "an outage");
});

test("a replay that would read a lot says so, in money, and asks", () => {
  const d = describeCalibration({ kpi: "ok", stage: "needs_go_ahead", reasons: [], estimate: { periods: 26, bytes_per_period: 15e9, total_bytes: 390e9, measured: false }, progress: { done: 0, total: 26 }, flagged: [], not_judged: [] }) as { say: string; next: string; needs_go_ahead: boolean };
  assert.equal(d.needs_go_ahead, true);
  assert.match(d.say, /26 past periods would read roughly .* GB in all \(about \$/);
  assert.match(d.next, /go_ahead/);
});

test("a labelled period must exist, and the answer must be yes or no", async () => {
  const { cfg } = await replayed({});
  assert.throws(() => labelPeriodTool(cfg, { kpi: "ok", period: "2099-W01", real: true }), /was not one of the replayed periods/);
  assert.throws(() => labelPeriodTool(cfg, { kpi: "ok", period: "2026-W07", real: undefined as never }), /real true or false/);
  assert.match((calibrationStatusTool({ packDir: mkdtempSync(join(tmpdir(), "cs-")) } as ServerConfig, { kpi: "ok" }) as { say: string }).say, /has not been checked/);
});

test("planted faults are told in plain words: what was found, that the data was not touched, and that a miss does not count", async () => {
  const { describeFaults } = await import("../src/handlers.js");
  const outcome = (kind: string, pass: boolean, applicable = true) => ({ id: kind, kind, applicable, pass, what: applicable ? `planted ${kind}` : "no second part", at: "" });
  const all = describeFaults({ kpi: "ok", stage: "done", reasons: [], progress: { done: 4, total: 4 }, period: { label: "2026-W11", words: "2026-03-09 to 2026-03-15" }, control: { quiet: true, detail: "nothing raised" }, outcomes: [outcome("segment_shift", true), outcome("offsetting_pair", true), outcome("mix_shift", true), outcome("data_gap", true)] as never, level: "verified", summary: { planted: 4, found: 4, not_applicable: 0 } }) as { say: string; next: string };
  assert.match(all.say, /planted 4 kinds of fault and the analysis found 4 of them\. The same period with nothing planted stayed quiet\. Your own data was not touched\./);
  assert.match(all.say, /counts as independent proof, so the KPI is now verified/);
  const miss = describeFaults({ kpi: "ok", stage: "done", reasons: [], progress: { done: 4, total: 4 }, period: { label: "p", words: "w" }, control: { quiet: true, detail: "" }, outcomes: [outcome("segment_shift", true), outcome("offsetting_pair", false), outcome("mix_shift", true, false), outcome("data_gap", true)] as never, level: "calibrated", summary: { planted: 3, found: 2, not_applicable: 1 } }) as { say: string; next: string };
  assert.match(miss.say, /one part worse while another got better: NOT found/);
  assert.match(miss.say, /volume moving between parts: could not be planted in this data \(no second part\)/);
  assert.match(miss.say, /That does not count as proof/);
  assert.match(miss.next, /Never change the KPI's definition/);
  const noisy = describeFaults({ kpi: "ok", stage: "done", reasons: [], progress: { done: 1, total: 1 }, period: { label: "p", words: "w" }, control: { quiet: false, detail: "1 finding(s)" }, outcomes: [outcome("segment_shift", true)] as never, level: "reconciled", summary: { planted: 1, found: 1, not_applicable: 0 } }) as { say: string };
  assert.match(noisy.say, /was NOT quiet \(1 finding\(s\)\), so these results do not count/);
  assert.match(noisy.say, /That does not count as proof/);
  assert.match((describeFaults({ kpi: "ok", stage: "not_ready", reasons: ["Run the false-alarm check first."], progress: { done: 0, total: 0 }, outcomes: [] }) as { say: string }).say, /Run the false-alarm check first/);
});
