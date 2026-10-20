// Needs Python (the data generator) and the Toolbox binary: run with `npm run test:integration` (CAUSELINE_INTEGRATION=1).
// The Builder's own tools, driven by a script instead of an agent, from raw CSVs to a verified expert. The agent
// run (scripts/builder-proof.mjs) is the same path with a language model doing the drafting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ToolboxProcess, SdkToolCaller } from "@causeline/runner";
import { loadAgents } from "@causeline/schema";
import { addIncident, buildStatus, confirmNumber, confirmPlayBack, connectFiles, describeData, playBack, proposeChecks, readState, reconcileMetric, savePack, verifyExpert } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const enabled = process.env.CAUSELINE_INTEGRATION === "1";

test("from raw CSVs to a verified expert, step by step", { skip: !enabled && "set CAUSELINE_INTEGRATION=1", timeout: 600000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "builder-e2e-"));
  const py = process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");
  // a worked example: the contact-centre generator, with one planted problem, exported as plain CSVs
  const gen = spawnSync(py, [join(repo, "packs", "contact-centre", "data", "generate.py"), "--fault", "understaffed:team_05:wk7", "--out-dir", join(dir, "raw")], { encoding: "utf-8" });
  assert.equal(gen.status, 0, gen.stderr);
  const files = readdirSync(join(dir, "raw")).filter((f) => f.endsWith(".csv")).map((f) => join(dir, "raw", f));

  const ws = join(dir, "workspace");
  const connected = await connectFiles({ workspace: ws, files });
  assert.equal(connected.tables.length, 2);
  const described = await describeData(ws);
  assert.ok(described.hierarchies.some((h) => h.table === "agents" && h.levels.includes("team")), JSON.stringify(described.hierarchies));
  assert.ok(described.joins.some((j) => j.from === "calls.agent" && j.to === "agents.agent"));

  // the draft an agent would make, here taken from the shipped pack (same table and column names)
  const pack = join(repo, "packs", "contact-centre");
  const ontology = parse(readFileSync(join(pack, "ontology.yaml"), "utf-8"));
  const data = parse(readFileSync(join(pack, "data.yaml"), "utf-8"));
  data.source = connected.source;
  delete ontology.metrics.workload; // a product of two other KPIs: not part of this walk-through
  const saved = await savePack({ workspace: ws, ontology, data, agents: [{ name: "service-level-deep-rca", kpi: "service_level", task: "deep_rca", playbook: undefined, examples: ["Why did service level drop?"] }] });
  assert.equal(saved.saved, true, saved.errors.join("; "));
  assert.deepEqual(saved.needs_reconciling.sort(), ["aht", "calls_offered", "service_level"]);
  assert.match(playBack(ws).sentences.map((s) => s.text).join("\n"), /service level .* is the average of "answered within 20s"/);
  assert.equal(confirmPlayBack(ws).confirmed, true);

  const server = await ToolboxProcess.start({ cwd: ws, configDir: "toolbox" });
  try {
    const tools = new SdkToolCaller(server.url);
    const wrong = await reconcileMetric({ workspace: ws, kpi: "service_level", period: "week 6", expected: 50, tools });
    assert.equal(wrong.match, false);
    assert.ok(wrong.hints.length >= 2);
    assert.equal(buildStatus(ws).steps.find((s) => s.step.startsWith("KPI service_level"))!.done, false);

    // the truth, worked out from the CSVs rather than by the system under test
    let total = 0;
    let ok = 0;
    const start = Date.UTC(2026, 0, 5) + 5 * 7 * 86_400_000; // week 6 starts 2026-02-09
    for (const l of readFileSync(join(dir, "raw", "calls.csv"), "utf-8").trim().split("\n").slice(1)) {
      const c = l.split(","); // call_id,ts,agent,queue,call_reason,answered_within_20s,handle_seconds,is_holiday,is_peak
      const t = new Date(c[1].replace(" ", "T") + "Z").getTime();
      if (t < start || t >= start + 7 * 86_400_000) continue;
      total++;
      ok += Number(c[5]);
    }
    const known = Math.round((ok / total) * 1000) / 10;
    const right = await reconcileMetric({ workspace: ws, kpi: "service_level", period: "week 6", expected: known, tolerance: 0.002, tools });
    assert.equal(right.match, true, JSON.stringify(right));
    assert.equal(right.level, "provisional", "one confirmed number is the first rung, not the last");
    assert.equal(buildStatus(ws).steps.find((s) => s.step.startsWith("KPI service_level"))!.done, false);

    addIncident({ workspace: ws, kpi: "service_level", period: "2026-W07", finding: { dimension: "team", value: "team_05" }, question: "Why did service level drop in week 7?" });
    const early = await verifyExpert({ workspace: ws, kpi: "service_level" });
    assert.equal(early.verified, false);
    assert.match(early.reasons.join("; "), /service_level is not verified yet \(it is provisional\)/);

    // a second number, of a different kind (one day), again from the CSVs and not from the system under test
    const proposed = await proposeChecks({ workspace: ws, kpi: "service_level", tools });
    assert.ok(proposed.proposals.some((p) => p.kind === "grain"), JSON.stringify(proposed.proposals));
    const grain = readState(ws)!.kpis.service_level.checks.find((c) => c.kind === "grain")!;
    let dayTotal = 0;
    let dayOk = 0;
    for (const l of readFileSync(join(dir, "raw", "calls.csv"), "utf-8").trim().split("\n").slice(1)) {
      const c = l.split(",");
      if (c[1].slice(0, 10) !== grain.window.start) continue;
      dayTotal++;
      dayOk += Number(c[5]);
    }
    const day = await confirmNumber({ workspace: ws, kpi: "service_level", check: grain.id, expected: dayOk / dayTotal, source: "the daily export", tolerance: 0.002, tools });
    assert.equal(day.confirmed, true, JSON.stringify(day));
    assert.equal(day.level, "verified", day.gap);
    assert.equal(buildStatus(ws).steps.find((s) => s.step.startsWith("KPI service_level"))!.done, true);

    const verified = await verifyExpert({ workspace: ws, kpi: "service_level" });
    assert.equal(verified.verified, true, verified.reasons.join("; "));
    assert.equal(loadAgents(ws).find((a) => a.kpi === "service_level" && a.task === "deep_rca")!.status, "verified");
  } finally {
    await server.stop();
  }
});
