import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadAgents } from "@causeline/schema";
import type { Row, ToolCaller } from "@causeline/runner";
import { acceptSample, autoChecks, confirmNumber, decide, dayWords, proposeChecks, recordNumber, runChecks, settledEnd, signoffStatus } from "../src/checks.js";
import { connectFiles } from "../src/connect.js";
import { savePack } from "../src/savepack.js";
import { levelGap, levelOf, readState, unconfirmedNumbers, writeState, type KpiRecord } from "../src/state.js";
import { SqliteToolCaller as SqliteTools } from "../src/sqlite-tools.js";

// 6 whole weeks from Monday 2026-01-05, 8 rows a day over three sites in two regions and two channels.
const SITES = ["n1", "n2", "s1"];
interface Row_ {
  id: string;
  region: string;
  site: string;
  channel: string;
  day: string;
  ok: number;
}
const rows: Row_[] = [];
for (let d = 0; d < 42; d++) {
  const day = new Date(Date.UTC(2026, 0, 5 + d)).toISOString().slice(0, 10);
  for (let k = 0; k < 8; k++) {
    const site = SITES[k % 3];
    rows.push({ id: `E${d}_${k}`, region: site.startsWith("n") ? "north" : "south", site, channel: k % 2 ? "web" : "phone", day, ok: (d * 7 + k) % 5 !== 0 ? 1 : 0 });
  }
}
/** The truth, worked out here from the rows and not by the system under test. */
const truth = (from: string, to: string, keep: (r: Row_) => boolean = () => true) => {
  const inside = rows.filter((r) => r.day >= from && r.day <= to && keep(r));
  return { rate: inside.reduce((a, r) => a + r.ok, 0) / inside.length, count: inside.length };
};
const LAST_WEEK = { from: "2026-02-09", to: "2026-02-15" };

const ontology = { time: { levels: ["week", "day"], seasonality: "none" }, hierarchies: { geo: ["region", "site"] }, dimensions: ["channel"], metrics: { ok_rate: { type: "ratio", direction: "higher_is_better", min_volume: 5 }, handled: { type: "sum", direction: "higher_is_better", min_volume: 5 } } };
const data = (numerator = "ok", sql = "SELECT event_id, happened_at AS ts, region, site, channel, ok FROM events") => ({
  source: "ws-db",
  facts: { events: { sql, time: "ts", concepts: ["region", "site", "channel"], one_row_per: { table: "events", column: "event_id" } } },
  metrics: { ok_rate: { fact: "events", numerator }, handled: { fact: "events", value: "ok" } },
});

async function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "builder-checks-"));
  const csv = join(dir, "events.csv");
  writeFileSync(csv, ["event_id,region,site,channel,happened_at,ok", ...rows.map((r) => `${r.id},${r.region},${r.site},${r.channel},${r.day} 09:00:00,${r.ok}`)].join("\n") + "\n");
  const ws = join(dir, "ws");
  await connectFiles({ workspace: ws, files: [csv] });
  const saved = await savePack({ workspace: ws, ontology, data: data(), agents: [{ name: "ok-rate-deep-rca", kpi: "ok_rate", task: "deep_rca", examples: ["Why did the ok rate drop?"] }] });
  assert.equal(saved.saved, true, saved.errors.join("; "));
  return { ws, tools: new SqliteTools(ws), dir };
}

/** Confirm the three proposed kinds of number (the whole business last week, one slice of it, one day): enough for the first rung. */
async function reconcileAll(ws: string, tools: SqliteTools, kpi = "ok_rate") {
  const p = await proposeChecks({ workspace: ws, kpi, tools });
  const [total, slice, grain] = ["total", "slice", "grain"].map((k) => p.proposals.find((x) => x.kind === k)!);
  const value = (from: string, to: string, keep?: (r: Row_) => boolean) => (kpi === "ok_rate" ? truth(from, to, keep).rate : truth(from, to, keep).rate * truth(from, to, keep).count);
  const sc = readState(ws)!.kpis[kpi].checks.find((c) => c.id === slice.id)!;
  const [c, v] = Object.entries(sc.scope)[0];
  const day = readState(ws)!.kpis[kpi].checks.find((x) => x.id === grain.id)!.window.start;
  await confirmNumber({ workspace: ws, kpi, check: total.id, expected: value(LAST_WEEK.from, LAST_WEEK.to), source: "a report", tolerance: 0.002, tools });
  await confirmNumber({ workspace: ws, kpi, check: slice.id, expected: value(LAST_WEEK.from, LAST_WEEK.to, (x) => (x as unknown as Record<string, string>)[c] === v), source: "a report", tolerance: 0.002, tools });
  return confirmNumber({ workspace: ws, kpi, check: grain.id, expected: value(day, day), source: "a report", tolerance: 0.002, tools });
}

test("day spans are said in plain words", () => {
  assert.equal(dayWords("2026-02-09", "2026-02-15"), "9–15 February 2026");
  assert.equal(dayWords("2026-02-15", "2026-02-15"), "15 February 2026");
  assert.equal(dayWords("2026-02-28", "2026-03-06"), "28 February – 6 March 2026");
});

test("the ladder is worked out from what is stored and cannot be set by hand", () => {
  const W1 = { start: "2026-01-05", end: "2026-01-11" };
  const W2 = { start: "2026-01-12", end: "2026-01-18" };
  const check = (kind: "total" | "slice" | "grain", source = "a report", state: "confirmed" | "pending" | "flagged" | "plausible" = "confirmed", window = W1) => ({ id: `${kind}-${window.start}`, kind, scope: {}, window, label: kind, got: 1, expected: 1, source, tolerance: 0.01, state });
  const auto = { at: "now", pass: true, results: [] };
  const rec = (checks: KpiRecord["checks"], a: KpiRecord["auto"] | null = auto): KpiRecord => ({ level: "verified", checks, ...(a ? { auto: a } : {}) });
  assert.equal(levelOf(undefined), "draft");
  assert.equal(levelOf(rec([])), "draft", "claiming verified on the record changes nothing");
  assert.equal(levelOf(rec([check("total", "a report", "pending")])), "draft");
  assert.equal(levelOf(rec([check("total")])), "draft", "one confirmed number is not enough");
  assert.equal(levelOf(rec([check("total"), check("slice"), check("grain")])), "draft", "three numbers from one period are one angle in time");
  assert.equal(levelOf(rec([check("total"), check("total", "a report", "confirmed", W2), check("total", "a report", "confirmed", { start: "2026-01-19", end: "2026-01-25" })])), "draft", "three numbers of one kind");
  assert.equal(levelOf(rec([check("total"), check("slice"), check("grain", "a report", "confirmed", W2)])), "reconciled", "three numbers, two periods, three kinds");
  assert.equal(levelOf(rec([check("total"), check("slice"), check("grain", " ", "confirmed", W2)])), "draft", "a number with no named source does not count");
  assert.equal(levelOf(rec([check("total"), check("slice"), check("grain", "a report", "confirmed", W2), { ...check("slice", "a report", "flagged", W2) }])), "draft", "a flagged number blocks the rung");
  assert.equal(levelOf(rec([check("total"), check("slice"), check("grain", "a report", "confirmed", W2)], { at: "now", pass: false, results: [{ id: "x", ok: false, detail: "rows repeat" }] })), "draft", "an automatic failure outranks matching numbers");
  assert.equal(levelOf(rec([check("total"), check("slice"), check("grain", "a report", "confirmed", W2)], null)), "draft", "automatic checks not run since a change: no rung");
  assert.match(levelGap(rec([check("total")])), /needs 2 more confirmed numbers, a number of a different kind from total, a number for a different period/);

  // the rungs above need what only calibration and verification can store
  const good = rec([check("total"), check("slice"), check("grain", "a report", "confirmed", W2)]);
  assert.equal(levelOf({ ...good, verification: { at: "now", pass: true, incidents_passed: ["i"] } }), "reconciled", "incidents without calibration do not skip a rung");
  const calibrated = { ...good, calibration: { at: "now", pass: true, false_alarm_rate: 0.02, allowed: 0.05, quiet_periods: 40 } };
  assert.equal(levelOf(calibrated), "calibrated");
  assert.equal(levelOf({ ...calibrated, verification: { at: "now", pass: true, incidents_passed: ["i"] } }), "verified");
  assert.equal(levelOf({ ...calibrated, calibration: { ...calibrated.calibration, pass: false } }), "reconciled");

  // a plausible sample counts toward nothing, and is said
  const sample = rec([check("total", "", "plausible")]);
  assert.equal(levelOf(sample), "draft");
  assert.equal(unconfirmedNumbers(sample), true);
  assert.equal(unconfirmedNumbers(good), false);
});

test("a version 1 build file is read as the current version: its matched number is one confirmed total, so a draft that needs more", async () => {
  const { ws } = await workspace();
  const s = readState(ws)!;
  writeState(ws, { ...s, version: 1, kpis: { ok_rate: { status: "reconciled", reconciled: { period: "2026-W06", expected: 0.8, got: 0.8, tolerance: 0.01 } }, handled: { status: "tested" } } } as never);
  const upgraded = readState(ws)!;
  assert.equal(upgraded.version, 3);
  assert.equal(levelOf(upgraded.kpis.ok_rate), "draft");
  assert.equal(upgraded.kpis.ok_rate.checks[0].kind, "total");
  assert.equal(levelOf(upgraded.kpis.handled), "draft");
  assert.ok(upgraded.status_log.some((c) => c.subject === "kpi:ok_rate" && c.by === "migration" && /needs three numbers/.test(c.why)));
});

test("a version 2 build (draft, provisional, verified) is read with the new ladder: verified stands as reconciled until the KPI changes; provisional is a draft", async () => {
  const { ws, tools } = await workspace();
  const confirmed = (id: string, kind: string) => ({ id, kind, scope: {}, window: { start: "2026-02-09", end: "2026-02-15" }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" });
  const s = readState(ws)!;
  writeState(ws, {
    ...s,
    version: 2,
    status_log: undefined,
    kpis: {
      ok_rate: { level: "verified", checks: [confirmed("total-1", "total"), confirmed("slice-1", "slice")], auto: { at: "now", pass: true, results: [] } },
      handled: { level: "provisional", checks: [confirmed("total-1", "total")], auto: { at: "now", pass: true, results: [] } },
    },
  } as never);
  const upgraded = readState(ws)!;
  assert.equal(levelOf(upgraded.kpis.ok_rate), "reconciled");
  assert.deepEqual(upgraded.kpis.ok_rate.grandfathered?.from, "verified");
  assert.equal(levelOf(upgraded.kpis.handled), "draft");
  assert.deepEqual(upgraded.status_log.map((c) => [c.subject, c.from, c.to, c.by]), [["kpi:ok_rate", "reconciled", "reconciled", "migration"], ["kpi:handled", "draft", "draft", "migration"]]);

  // writing it back and reading it again changes nothing, and nothing is logged twice
  writeState(ws, upgraded);
  assert.deepEqual(readState(ws), upgraded);

  // a change to the KPI ends the grandfathering: it is a draft until the numbers are worked again
  await savePack({ workspace: ws, ontology, data: data("ok * 1") });
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), "draft");
  assert.ok(readState(ws)!.status_log.some((c) => c.subject === "kpi:ok_rate" && c.from === "reconciled" && c.to === "draft" && c.by === "save_pack"));
  void tools;
});

test("proposed checks are chosen by rule and hide the tools' numbers until the person has given theirs", async () => {
  const { ws, tools } = await workspace();
  const p = await proposeChecks({ workspace: ws, kpi: "ok_rate", tools });
  assert.deepEqual(p.proposals.map((x) => x.kind), ["total", "slice", "slice", "grain"]);
  assert.match(p.proposals[0].label, /^The whole business, 9–15 February 2026$/);
  assert.match(p.proposals[3].label, /^The whole business, on 15 February 2026$/);
  assert.ok(p.proposals.every((x) => !("got" in x) && !/0\.\d{3}/.test(JSON.stringify(x))), "no number is offered with the question");
  const shown = JSON.stringify(signoffStatus(ws, "ok_rate"));
  assert.ok(!shown.includes('"got"'), "the status does not show a number for a check not yet answered");
  // asking again replaces what nobody answered rather than piling up
  assert.equal((await proposeChecks({ workspace: ws, kpi: "ok_rate", tools })).proposals.length, 4);
  assert.equal(readState(ws)!.kpis.ok_rate.checks.length, 4);
});

test("a KPI climbs from draft to reconciled as numbers from different angles and periods are confirmed", async () => {
  const { ws, tools } = await workspace();
  const p = await proposeChecks({ workspace: ws, kpi: "ok_rate", tools });
  const total = p.proposals.find((x) => x.kind === "total")!;
  const slices = p.proposals.filter((x) => x.kind === "slice");
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), "draft");

  // a wrong number is not confirmed; the tools' number is revealed with where to look
  const wrong = await confirmNumber({ workspace: ws, kpi: "ok_rate", check: total.id, expected: 50, source: "the weekly report", tools });
  assert.equal(wrong.confirmed, false);
  assert.equal(wrong.match, false);
  assert.ok(Math.abs(wrong.got - truth(LAST_WEEK.from, LAST_WEEK.to).rate) < 1e-9);
  assert.ok(wrong.hints.length >= 3);
  await assert.rejects(decide({ workspace: ws, kpi: "ok_rate", check: total.id, decision: "confirm", tools }), /do not match/);

  // the right number, said as a percentage, with a source: still a draft (one number is not enough), and the automatic checks pass
  const week = truth(LAST_WEEK.from, LAST_WEEK.to).rate;
  const first = await confirmNumber({ workspace: ws, kpi: "ok_rate", check: total.id, expected: Math.round(week * 1000) / 10, source: "the weekly report", tolerance: 0.002, tools });
  assert.equal(first.confirmed, true, JSON.stringify(first));
  assert.equal(first.level, "draft");
  assert.match(first.gap, /needs 2 more confirmed numbers, a number of a different kind from total, a number for a different period/);
  const auto = readState(ws)!.kpis.ok_rate.auto!;
  assert.equal(auto.pass, true, JSON.stringify(auto.results.filter((r) => !r.ok)));
  assert.ok(auto.results.some((r) => r.id === "parts_add_up:region" && r.ok));
  assert.ok(auto.results.some((r) => r.id === "no_repeated_rows" && r.ok && !r.skipped));

  // a second number of a different kind: one site, same week
  const sliceCheck = readState(ws)!.kpis.ok_rate.checks.find((c) => c.id === slices[0].id)!;
  const [concept, value] = Object.entries(sliceCheck.scope)[0];
  const part = truth(LAST_WEEK.from, LAST_WEEK.to, (r) => (r as unknown as Record<string, string>)[concept] === value).rate;
  const second = await confirmNumber({ workspace: ws, kpi: "ok_rate", check: slices[0].id, expected: part, source: "the regional report", tolerance: 0.002, tools });
  assert.equal(second.level, "draft", "a second number from the same period is not enough");
  assert.match(second.gap, /needs 1 more confirmed number, a number for a different period/);

  // a third number, from a different period (the last day) and a different kind
  const grain = p.proposals.find((x) => x.kind === "grain")!;
  const day = readState(ws)!.kpis.ok_rate.checks.find((c) => c.id === grain.id)!.window.start;
  const third = await confirmNumber({ workspace: ws, kpi: "ok_rate", check: grain.id, expected: truth(day, day).rate, source: "the daily dashboard", tolerance: 0.002, tools });
  assert.equal(third.level, "reconciled", third.gap);
  assert.equal(signoffStatus(ws, "ok_rate")[0].level, "reconciled");
  assert.equal(readState(ws)!.status_log.filter((c) => c.subject === "kpi:ok_rate").at(-1)!.to, "reconciled");
  assert.equal(signoffStatus(ws, "ok_rate")[0].checks.find((c) => c.id === total.id)!.source, "the weekly report");
});

test("flagging a number keeps a KPI from reconciled until it is sorted out", async () => {
  const { ws, tools } = await workspace();
  const p = await proposeChecks({ workspace: ws, kpi: "ok_rate", tools });
  const [total, slice, grain] = ["total", "slice", "grain"].map((k) => p.proposals.find((x) => x.kind === k)!);
  const week = truth(LAST_WEEK.from, LAST_WEEK.to).rate;
  await confirmNumber({ workspace: ws, kpi: "ok_rate", check: total.id, expected: week, source: "a report", tolerance: 0.002, tools });
  await recordNumber({ workspace: ws, kpi: "ok_rate", check: grain.id, expected: 0.01, source: "a report", tools });
  assert.equal((await decide({ workspace: ws, kpi: "ok_rate", check: grain.id, decision: "flag", note: "the day looks off", tools })).state, "flagged");
  const sc = readState(ws)!.kpis.ok_rate.checks.find((c) => c.id === slice.id)!;
  const [c, v] = Object.entries(sc.scope)[0];
  const r = await confirmNumber({ workspace: ws, kpi: "ok_rate", check: slice.id, expected: truth(LAST_WEEK.from, LAST_WEEK.to, (x) => (x as unknown as Record<string, string>)[c] === v).rate, source: "a report", tolerance: 0.002, tools });
  assert.equal(r.level, "draft");
  assert.match(r.gap, /a number is flagged/);
});

test("a change to a KPI drops it, its expert goes back to draft, and run_checks restores it only if the stored numbers still match", async () => {
  const { ws, tools } = await workspace();
  await reconcileAll(ws, tools);
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), "reconciled");
  // the expert stands where its KPI stands
  assert.equal(loadAgents(ws).find((a) => a.name === "ok-rate-deep-rca")!.status, "reconciled");
  assert.ok(readState(ws)!.status_log.some((c) => c.subject === "expert:ok-rate-deep-rca" && c.to === "reconciled"));

  // the same meaning written another way: it is a change, so the KPI drops and the expert is a draft again
  const same = await savePack({ workspace: ws, ontology, data: data("ok * 1") });
  assert.deepEqual(same.needs_reconciling.sort(), ["ok_rate"]);
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), "draft", "confirmed numbers stay on record but are no longer vouched for");
  assert.equal(loadAgents(ws).find((a) => a.name === "ok-rate-deep-rca")!.status, "draft");
  assert.ok(readState(ws)!.status_log.some((c) => c.subject === "expert:ok-rate-deep-rca" && c.from === "reconciled" && c.to === "draft"));
  const again = await runChecks({ workspace: ws, kpi: "ok_rate", tools: new SqliteTools(ws) });
  assert.equal(again.restored, true, JSON.stringify(again));
  assert.equal(again.after, "reconciled");
  assert.ok(again.rechecked.every((r) => r.match));
  assert.equal(loadAgents(ws).find((a) => a.name === "ok-rate-deep-rca")!.status, "reconciled", "the expert follows its KPI back up");

  // a different meaning: the stored numbers no longer match and nothing is restored
  await savePack({ workspace: ws, ontology, data: data("1 - ok") });
  const broken = await runChecks({ workspace: ws, kpi: "ok_rate", tools: new SqliteTools(ws) });
  assert.equal(broken.restored, false);
  assert.notEqual(broken.after, "reconciled");
  assert.ok(broken.rechecked.every((r) => !r.match && /no longer matches/.test(r.note ?? "")));
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), "draft", "nothing is confirmed any more");
});

test("a number accepted as plausible counts toward nothing, and the KPI and its expert say the numbers were not confirmed", async () => {
  const { ws, tools } = await workspace();
  const p = await proposeChecks({ workspace: ws, kpi: "ok_rate", tools });
  const sample = p.proposals.filter((x) => x.kind === "slice")[1];
  const r = acceptSample({ workspace: ws, kpi: "ok_rate", check: sample.id });
  assert.equal(r.state, "plausible");
  assert.equal(r.level, "draft");
  const sc = readState(ws)!.kpis.ok_rate.checks.find((c) => c.id === sample.id)!;
  const [c, v] = Object.entries(sc.scope)[0];
  assert.ok(Math.abs(r.got - truth(LAST_WEEK.from, LAST_WEEK.to, (x) => (x as unknown as Record<string, string>)[c] === v).rate) < 1e-9, "the person is shown our number to judge");
  assert.equal(signoffStatus(ws, "ok_rate")[0].unconfirmed, true);
  assert.equal(loadAgents(ws).find((a) => a.name === "ok-rate-deep-rca")!.unconfirmed_numbers, true);
  assert.ok(readState(ws)!.status_log.every((c) => c.subject !== "kpi:ok_rate" || c.to !== "reconciled"), "no rung was earned");
  // real numbers later reconcile it, and the flag goes
  await reconcileAll(ws, tools);
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), "reconciled");
  assert.equal(signoffStatus(ws, "ok_rate")[0].unconfirmed, false);
  assert.equal(loadAgents(ws).find((a) => a.name === "ok-rate-deep-rca")!.unconfirmed_numbers, false);
});

test("a join that repeats rows is caught by the automatic checks, and parts that do not add up are too", async () => {
  const { ws, tools } = await workspace();
  // the fact joins a table with a repeated key: every n1 event appears twice
  const sql = "SELECT e.event_id, e.happened_at AS ts, e.region, e.site, e.channel, e.ok FROM events e JOIN (SELECT 'n1' AS site UNION ALL SELECT 'n1' UNION ALL SELECT 'n2' UNION ALL SELECT 's1') s ON s.site = e.site";
  const saved = await savePack({ workspace: ws, ontology, data: data("ok", sql) });
  assert.equal(saved.saved, true, saved.errors.join("; "));
  const repeated = (await autoChecks({ workspace: ws, kpi: "ok_rate", tools: new SqliteTools(ws) })).find((r) => r.id === "no_repeated_rows")!;
  assert.equal(repeated.ok, false);
  assert.match(repeated.detail, /has 462 rows but events has 336 different event_id/);

  // parts that do not add up: a split that loses a row
  const lossy: ToolCaller = {
    call: async (tool: string, params: Record<string, string>, step: string): Promise<Row[]> => {
      const out = await tools.call(tool, params, step);
      return tool.includes("by_region") || /_by_region/.test(tool) ? out.slice(1) : out;
    },
  };
  await savePack({ workspace: ws, ontology, data: data() });
  const lost = (await autoChecks({ workspace: ws, kpi: "ok_rate", tools: lossy })).find((r) => r.id === "parts_add_up:region")!;
  assert.equal(lost.ok, false, lost.detail);
});

test("without one_row_per the repeated-rows check says it was not run, and does not pass or fail", async () => {
  const { ws } = await workspace();
  const d = data();
  delete (d.facts.events as Record<string, unknown>).one_row_per;
  await savePack({ workspace: ws, ontology, data: d });
  const r = (await autoChecks({ workspace: ws, kpi: "ok_rate", tools: new SqliteTools(ws) })).find((x) => x.id === "no_repeated_rows")!;
  assert.equal(r.skipped, true);
  assert.match(r.detail, /one_row_per/);
});

test("a number the person gives is read as a percentage for a rate, and a sum is left alone", async () => {
  const { ws, tools } = await workspace();
  const p = await proposeChecks({ workspace: ws, kpi: "handled", tools });
  const total = p.proposals.find((x) => x.kind === "total")!;
  const week = truth(LAST_WEEK.from, LAST_WEEK.to);
  const wrong = await recordNumber({ workspace: ws, kpi: "handled", check: total.id, expected: week.count, source: "a report", tools });
  assert.equal(wrong.match, false, "handled counts the ok rows, not every row");
  const right = await confirmNumber({ workspace: ws, kpi: "handled", check: total.id, expected: Math.round(week.rate * week.count), source: "a report", tools });
  assert.equal(right.confirmed, true, JSON.stringify(right));
  await assert.rejects(recordNumber({ workspace: ws, kpi: "handled", check: total.id, expected: 5, source: "a report", tools }), /already confirmed/);
  await assert.rejects(recordNumber({ workspace: ws, kpi: "handled", check: "nope-1", expected: 5, source: "a report", tools }), /there is no check "nope-1"/);
  await assert.rejects(recordNumber({ workspace: ws, kpi: "handled", check: total.id, expected: 5, source: "  ", tools }), /where the number comes from|already confirmed/);
});

test("a changed pack has its unanswered proposals dropped", async () => {
  const { ws, tools } = await workspace();
  await proposeChecks({ workspace: ws, kpi: "ok_rate", tools });
  await savePack({ workspace: ws, ontology, data: data("ok * 1") });
  assert.equal(readState(ws)!.kpis.ok_rate.checks.length, 0, "their numbers were for the old formula");
});

test("a window the person has a report for counts as the kind its shape says, so their own windows can verify a KPI", async () => {
  const { ws, tools } = await workspace();
  const kindOf = async (odd: { start: string; end: string; name?: string; scope?: Record<string, string> }) => (await proposeChecks({ workspace: ws, kpi: "ok_rate", tools, odd })).proposals.find((p) => /2026-01-1[2-8]|12–18 January|13 January/.test(p.label))?.kind;
  assert.equal(await kindOf({ start: "2026-01-12", end: "2026-01-18" }), "total");
  assert.equal(await kindOf({ start: "2026-01-13", end: "2026-01-13" }), "grain");
  assert.equal(await kindOf({ start: "2026-01-12", end: "2026-01-18", scope: { channel: "web" } }), "slice");
  assert.equal(await kindOf({ start: "2026-01-12", end: "2026-01-18", name: "the audited week" }), "total", "a name is a label, not a different kind of angle");
});

test("a number far off for one KPI puts those days in doubt for the others on the same data, and a match brings them back", async () => {
  const { ws, tools } = await workspace();
  const week = { from: LAST_WEEK.from, to: LAST_WEEK.to };
  // ok_rate is reconciled from three numbers in the last week
  await reconcileAll(ws, tools);
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), "reconciled");

  // the person's count for the same week is far from ours: that week's data is in doubt, so ok_rate's numbers for it are set aside
  const h = await proposeChecks({ workspace: ws, kpi: "handled", tools });
  const handledTotal = h.proposals.find((x) => x.kind === "total")!;
  const real = Math.round(truth(week.from, week.to).rate * truth(week.from, week.to).count);
  const off = await confirmNumber({ workspace: ws, kpi: "handled", check: handledTotal.id, expected: Math.round(real * 1.6), source: "the live site", tools });
  assert.equal(off.confirmed, false);
  const after = readState(ws)!.kpis.ok_rate;
  assert.equal(levelOf(after), "draft", "its only numbers are for the days in doubt");
  assert.match(levelGap(after), /3 confirmed numbers are set aside because handled does not match the user's number for the same days/);
  assert.equal(signoffStatus(ws, "ok_rate")[0].level, "draft");
  assert.equal((await runChecks({ workspace: ws, kpi: "ok_rate", tools })).after, "draft", "re-running the stored numbers does not bring them back");

  // the person's number turns out to be for a week the data holds in full: the doubt is lifted
  const fixed = await confirmNumber({ workspace: ws, kpi: "handled", check: handledTotal.id, expected: real, source: "the live site", tolerance: 0.002, tools });
  assert.equal(fixed.confirmed, true);
  assert.equal(readState(ws)!.kpis.ok_rate.suspect, undefined);
  assert.equal(levelOf(readState(ws)!.kpis.ok_rate), "reconciled");
});

test("the newest periods are set aside when they hold far less than usual, as when the data was still arriving", () => {
  assert.equal(settledEnd([100, 102, 98, 101, 99, 100, 103]), 6, "an ordinary run is all settled");
  assert.equal(settledEnd([100, 102, 98, 101, 99, 100, 70]), 5, "the newest at 70% is still filling in");
  assert.equal(settledEnd([240, 220, 224, 211, 218, 241, 218, 178, 78]), 7, "the newest, at 35% of a normal one, is the tail; 178 is 81% of the median 220, so it stays");
  assert.equal(settledEnd([100, 100, 100]), 2, "too few periods to judge");
  assert.equal(settledEnd([100, 100, 100, 100, 100, 90, 60, 30]), 5, "a falling tail");
});
