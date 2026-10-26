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
