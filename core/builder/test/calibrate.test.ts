import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "@causeline/schema";
import { alarmOf, calibrate, calibrationStatus, evaluate, labelPeriod, sayRate, wilsonUpper, type CalibrationDeps, type PeriodOutcome } from "../src/calibrate.js";
import { levelOf, newState, readState, updateState, writeState } from "../src/state.js";

const weeks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    bucket: `2026-W${String(i + 1).padStart(2, "0")}`,
    bucket_start: new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10),
    bucket_end: new Date(Date.UTC(2026, 0, 11 + i * 7)).toISOString().slice(0, 10),
    num: 1,
    den: 1,
  }));

const quiet = { status: "complete", headline: { z: 0.4, significant: false }, findings: [], masking_flags: [] } as unknown as Result;
const loud = { status: "complete", headline: { z: 5, significant: true }, findings: [{ rank: 1, dimension: "site", value: "north", impact: -1, evidence: [] }], masking_flags: [] } as unknown as Result;
const refused = { status: "stopped", stopped_reason: "no_comparable_baseline", stopped_detail: "a holiday", headline: null, findings: [], masking_flags: [] } as unknown as Result;

function workspace(reconciled = true) {
  const ws = mkdtempSync(join(tmpdir(), "calibrate-"));
  writeState(ws, newState("x"));
  if (reconciled) {
    updateState(ws, (st) => {
      const check = (kind: "total" | "slice" | "grain", start: string, end: string) => ({ id: `${kind}-1`, kind, scope: {}, window: { start, end }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" as const });
      st.kpis.ok = { level: "reconciled", checks: [check("total", "2026-01-05", "2026-01-11"), check("slice", "2026-01-05", "2026-01-11"), check("grain", "2026-01-12", "2026-01-12")], auto: { at: "now", pass: true, results: [] } };
    });
  }
  return ws;
}

/** n weeks of history; `says` gives what the analysis says about each week by label. */
function deps(n: number, says: Record<string, Result>, key = "k1"): CalibrationDeps & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    baseline: 4,
    key: () => key,
    periods: async () => weeks(n),
    runOne: async (b) => {
      ran.push(b.bucket);
      return { result: says[b.bucket] ?? quiet, bytes: 0 };
    },
  };
}
const opts = (ws: string, d: CalibrationDeps, extra: object = {}) => ({ workspace: ws, kpi: "ok", makeTools: async () => ({}) as never, deps: d, ...extra });

test("a KPI that stays quiet over twelve ordinary weeks is calibrated, and the rung and its reason are logged", async () => {
  const ws = workspace();
  const r = await calibrate(opts(ws, deps(16, {})));
  assert.equal(r.stage, "done");
  assert.equal(r.evaluation!.judged, 12);
  assert.equal(r.evaluation!.alarms, 0);
  assert.equal(r.evaluation!.pass, true);
  assert.equal(levelOf(readState(ws)!.kpis.ok), "calibrated");
  assert.match(readState(ws)!.status_log.at(-1)!.why, /0 of 12 ordinary periods raised something/);
});

test("a KPI that raises something in too many ordinary weeks stays reconciled and lists the weeks to ask about", async () => {
  const ws = workspace();
  const says = { "2026-W07": loud, "2026-W09": loud, "2026-W12": loud, "2026-W14": loud };
  const r = await calibrate(opts(ws, deps(16, says)));
  assert.equal(r.evaluation!.alarms, 4);
  assert.equal(r.evaluation!.pass, false);
  assert.equal(levelOf(readState(ws)!.kpis.ok), "reconciled");
  assert.equal(r.flagged.length, 4);
  assert.match(r.flagged[0].what.join(" "), /significant change|finding/);
});

test("saying that something real happened in a flagged week takes it out of the count, and the rung follows", async () => {
  const ws = workspace();
  const d = deps(16, { "2026-W07": loud, "2026-W09": loud });
  await calibrate(opts(ws, d));
  assert.equal(levelOf(readState(ws)!.kpis.ok), "reconciled");
  const a = labelPeriod(ws, "ok", "2026-W07", true, "the system outage");
  assert.equal(a.evaluation.real_events, 1);
  assert.equal(a.evaluation.alarms, 1);
  labelPeriod(ws, "ok", "2026-W09", true);
  const again = await calibrate(opts(ws, d));
  assert.equal(again.stage, "done");
  assert.equal(again.evaluation!.alarms, 0);
  assert.equal(again.evaluation!.judged, 10);
  assert.equal(levelOf(readState(ws)!.kpis.ok), "calibrated");
  assert.equal(d.ran.length, 12, "the labels needed no second replay");
  assert.equal(calibrationStatus(ws, "ok").known_events.length, 2);
});

test("a week the analysis declines to judge is reported and counted neither way", async () => {
  const ws = workspace();
  const r = await calibrate(opts(ws, deps(16, { "2026-W10": refused, "2026-W11": refused })));
  assert.equal(r.evaluation!.not_judged, 2);
  assert.equal(r.evaluation!.judged, 10);
  assert.equal(r.not_judged[0].reason.startsWith("no_comparable_baseline"), true);
  assert.equal(r.evaluation!.pass, true);
});

test("with too few judged weeks it cannot be calibrated, however quiet", async () => {
  const ws = workspace();
  const r = await calibrate(opts(ws, deps(10, {})));
  assert.equal(r.evaluation!.judged, 6);
  assert.equal(r.evaluation!.enough, false);
  assert.equal(r.evaluation!.pass, false);
  assert.equal(levelOf(readState(ws)!.kpis.ok), "reconciled");
  const kept = readState(ws)!.kpis.ok.calibration!;
  assert.equal(kept.pass, false);
  assert.equal(kept.quiet_periods, 6);
  assert.equal(readState(ws)!.status_log.length, 0, "no change of rung, so nothing to log");
});

test("it needs a reconciled KPI", async () => {
  const r = await calibrate(opts(workspace(false), deps(16, {})));
  assert.equal(r.stage, "not_ready");
  assert.match(r.reasons[0], /is not reconciled yet/);
});

test("a stopped replay resumes without repeating weeks, and a changed KPI starts again", async () => {
  const ws = workspace();
  const d = deps(16, {});
  const first = await calibrate(opts(ws, d, { chunkMs: -1 }));
  assert.equal(first.stage, "running");
  assert.equal(first.progress.done, 1);
  const done = await calibrate(opts(ws, d));
  assert.equal(done.stage, "done");
  assert.equal(d.ran.length, 12, "each week ran once");
  assert.equal(new Set(d.ran).size, 12);
  const changed = deps(16, {}, "k2");
  await calibrate(opts(ws, changed));
  assert.equal(changed.ran.length, 12, "a different formula replays every week");
});

test("the allowed rate can be changed, and the change is kept", async () => {
  const ws = workspace();
  const d = deps(16, { "2026-W07": loud, "2026-W09": loud });
  const strict = await calibrate(opts(ws, d));
  assert.equal(strict.evaluation!.pass, false, "2 of 12 is more than one in twenty");
  const relaxed = await calibrate(opts(ws, d, { allowed: 0.2 }));
  assert.equal(relaxed.evaluation!.pass, true);
  assert.deepEqual(calibrationStatus(ws, "ok").adjustments.map((a) => [a.from, a.to]), [[0.05, 0.2]]);
  await assert.rejects(calibrate(opts(ws, d, { allowed: 2 })), /between 0 and 1/);
});

test("on cloud data a replay that would read a lot says so first, and only runs after a go-ahead", async () => {
  const ws = workspace();
  updateState(ws, (s) => {
    s.dialect = "bigquery";
  });
  const d = { ...deps(16, {}), tableBytes: async () => 2e9 };
  const ask = await calibrate(opts(ws, d));
  assert.equal(ask.stage, "needs_go_ahead");
  assert.equal(ask.estimate!.periods, 12);
  assert.equal(ask.estimate!.total_bytes, 2e9 * 6 * 12);
  assert.equal(ask.estimate!.measured, false);
  assert.equal(d.ran.length, 0, "nothing was read");
  const go = await calibrate(opts(ws, d, { goAhead: true }));
  assert.equal(go.stage, "done");
});

test("what counts as raising something: a significant headline, a finding, or a hidden pattern; nothing from a refusal", () => {
  assert.equal(alarmOf(quiet).alarm, false);
  assert.equal(alarmOf(loud).alarm, true);
  assert.equal(alarmOf(refused).alarm, false);
  assert.equal(alarmOf({ status: "complete", headline: { z: 0, significant: false }, findings: [], masking_flags: [{ type: "small_cells" }] } as unknown as Result).alarm, false, "thin cells are a caution, not a claim");
  assert.equal(alarmOf({ status: "complete", headline: { z: 0, significant: false }, findings: [], masking_flags: [{ type: "dispersion" }] } as unknown as Result).alarm, true);
});

test("the rate, its upper bound and its words", () => {
  const o = (alarm: boolean, i: number): PeriodOutcome => ({ period: `p${i}`, start: "2026-01-05", end: "2026-01-11", status: "judged", alarm, why: [], at: "" });
  const e = evaluate([...Array.from({ length: 19 }, (_, i) => o(false, i)), o(true, 99)], {}, 0.05);
  assert.equal(e.rate, 0.05);
  assert.equal(e.pass, true);
  assert.ok(e.upper > 0.1 && e.upper < 0.3, `a sample of 20 shows little: upper bound ${e.upper}`);
  assert.equal(sayRate(0.05), "about 1 in 20");
  assert.equal(sayRate(0), "none");
  assert.ok(wilsonUpper(0, 8) > 0.3);
  assert.equal(wilsonUpper(0, 0), 1);
});

test("a spread picks periods evenly through the whole history, says how it chose, and keeps what it already knew when the choice changes", async () => {
  const ws = workspace();
  const d = deps(44, {});
  const r = await calibrate(opts(ws, d, { spread: 10 }));
  assert.equal(r.stage, "done");
  assert.equal(d.ran.length, 10);
  assert.equal(r.progress.total, 10);
  assert.match(r.selection!, /^10 of 40 complete periods, evenly spaced from 2026-02-02 to /);
  // first and last of the usable periods are in; the gaps are even
  assert.equal([...d.ran].sort()[0], "2026-W05");
  assert.equal([...d.ran].sort().at(-1), "2026-W44");
  const idx = [...d.ran].sort().map((p) => Number(p.slice(-2)));
  const gaps = idx.slice(1).map((v, i) => v - idx[i]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `even: ${gaps}`);
  // a larger spread reuses what was replayed where the periods coincide, and only runs the rest
  const more = await calibrate(opts(ws, d, { spread: 19 }));
  assert.equal(more.progress.total, 19);
  assert.ok(d.ran.length < 10 + 19, "some periods of the first choice were reused");
  assert.equal(new Set(d.ran).size, d.ran.length, "no period ran twice");
});

test("a spread leaves out the periods that hold a recorded incident, and says how many", async () => {
  const ws = workspace();
  mkdirSync(join(ws, "evals"), { recursive: true });
  writeFileSync(
    join(ws, "evals", "cases.yaml"),
    [
      "- id: incident_1_ok",
      "  question: Why did ok change?",
      "  inputs: { metric: ok, period: 2026-W20, playbook: metric_change }",
      "  expect:",
      "    top_finding: { dimension: site, value: north }",
    ].join("\n") + "\n",
  );
  const d = deps(44, {});
  const r = await calibrate(opts(ws, d, { spread: 40 }));
  assert.ok(!d.ran.includes("2026-W20"), "the incident week was not counted as ordinary");
  assert.match(r.selection!, /39 of 39 complete periods|; 1 more left out because they hold a recorded incident/);
});
