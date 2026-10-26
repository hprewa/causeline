#!/usr/bin/env node
// The false-alarm check through the real MCP server over stdio on real data: a contact-centre workspace with no faults planted and a KPI recorded
// as reconciled (as the Builder would have left it), then `calibrate` until it is done, a label, and `calibration_status`.
//   node scripts/calibrate-proof.mjs [--seed 1] [--weeks 30]
// Nothing is read from a cloud database. The workspace is in a temporary folder.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadCases, prepareCase } from "../core/eval/dist/src/index.js";
import { newState, readState, updateState, writeState } from "../core/builder/dist/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const flag = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const seed = flag("seed", "1");
const weeks = flag("weeks", "30");
const failures = [];
const check = (n, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${detail ? `: ${String(detail).slice(0, 260)}` : ""}`);
  if (!ok) failures.push(n);
};

const pack = resolve(repo, "packs", "contact-centre");
const base = loadCases(pack, ["clean_week"])[0];
const work = await prepareCase(pack, { ...base, id: "calibrate_proof", setup: `--seed ${seed} --weeks ${weeks}` }, mkdtempSync(join(tmpdir(), "calibrate-proof-")), false);
// the Builder would have left a state beside the pack; record one reconciled KPI the way its checks do
writeState(work, { ...newState("contact-centre"), profiled: true });
updateState(work, (s) => {
  const c = (kind, start, end) => ({ id: `${kind}-1`, kind, scope: {}, window: { start, end }, label: kind, got: 1, expected: 1, source: "a report", tolerance: 0.01, state: "confirmed" });
  s.kpis.service_level = { level: "reconciled", checks: [c("total", "2026-01-05", "2026-01-11"), c("slice", "2026-01-05", "2026-01-11"), c("grain", "2026-01-12", "2026-01-12")], auto: { at: "now", pass: true, results: [] } };
});

const client = new Client({ name: "calibrate-proof", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")], env: { ...process.env, CAUSELINE_PACK: work, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), CAUSELINE_NO_BROWSER: "1" } }));
const tool = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { error: res.isError ? res.content?.[0]?.text : undefined, body: res.structuredContent };
};
try {
  const t0 = Date.now();
  let r;
  let calls = 0;
  do {
    r = await tool("calibrate", { kpi: "service_level" });
    calls++;
    if (r.error) break;
    console.log(`  [${calls}] ${r.body.stage}: ${r.body.say}`);
  } while (r.body?.stage === "running");
  check("the replay finished through the tool, in one or more calls", !r.error && r.body.stage === "done", r.error ?? r.body.say);
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s, ${calls} call(s)`);
  const ev = r.body?.evaluation;
  check("the periods were replayed on the real data (not made up)", ev && ev.judged + ev.not_judged >= 15, JSON.stringify({ judged: ev?.judged, not_judged: ev?.not_judged, alarms: ev?.alarms }));
  check("the week the analysis declines to compare (the holiday) is reported, not counted", (r.body?.not_judged ?? []).length >= 1, JSON.stringify(r.body?.not_judged?.[0]));
  check("the saying is in plain words with the tool's numbers", /ordinary periods I could judge/.test(r.body?.say ?? ""), r.body?.say);

  // a label on a flagged period (if any) moves the result without a new replay
  if ((r.body.flagged ?? []).length > 0) {
    const first = r.body.flagged[0];
    const l = await tool("label_period", { kpi: "service_level", period: first.period, real: true, note: "proof" });
    check("a label is recorded and the next step is said (the label here is only to test the flow: nothing real happened in this made-up data)", !l.error && !!l.body?.next, l.error ?? l.body?.next);
    const again = await tool("calibrate", { kpi: "service_level" });
    check("calibrating again after a label does not replay (it is quick)", !again.error && again.body.stage === "done", again.error ?? again.body?.say);
  }
  const st = await tool("calibration_status", { kpi: "service_level" });
  check("the status says where it stands", !st.error && /ordinary periods raised something/.test(st.body?.say ?? ""), st.error ?? st.body?.say);
  const rung = readState(work)?.kpis.service_level;
  check("the KPI's rung follows the result", rung && (rung.calibration?.pass ? rung.level === "calibrated" : rung.level === "reconciled"), JSON.stringify({ level: rung?.level, calibration: rung?.calibration }));
} finally {
  await client.close();
}
console.log(failures.length ? `\nFAILED: ${failures.join("; ")}` : "\nCALIBRATION RUN PASSED");
process.exit(failures.length ? 1 : 0);
