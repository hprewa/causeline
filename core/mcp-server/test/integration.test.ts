// Needs Python, DuckDB and the Toolbox binary, and takes about ten seconds: run with
// `npm run test:integration` (which sets CAUSELINE_INTEGRATION=1). Skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadCases, prepareCase } from "@causeline/eval";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const enabled = process.env.CAUSELINE_INTEGRATION === "1";

test("causeline-mcp runs a playbook end to end over stdio against a real Toolbox", { skip: !enabled && "set CAUSELINE_INTEGRATION=1" }, async () => {
  const pack = resolve(repo, "packs", "contact-centre");
  const c = loadCases(pack, ["understaffed_team"])[0];
  const workDir = await prepareCase(pack, c, mkdtempSync(resolve(tmpdir(), "mcp-int-")), false);

  const client = new Client({ name: "integration", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(here, "..", "src", "main.js")],
      env: { ...process.env, CAUSELINE_PACK: workDir, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks") } as Record<string, string>,
    }),
  );
  try {
    const res = (await client.callTool({ name: "run_playbook", arguments: { name: "metric_change", inputs: { metric: "service_level", period: "2026-W07" } } })) as any;
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    const result = res.structuredContent.result;
    assert.equal(result.status, "complete");
    assert.equal(result.findings[0].dimension, "team");
    assert.equal(result.findings[0].value, "team_05");
    assert.ok(result.steps.length > 10, "every query is logged");

    // a period that does not exist stops cleanly and says what does exist
    const missing = (await client.callTool({ name: "run_playbook", arguments: { name: "metric_change", inputs: { metric: "service_level", period: "2030-W01" } } })) as any;
    assert.equal(missing.structuredContent.result.stopped_reason, "period_not_found");
    assert.match(missing.structuredContent.result.stopped_detail, /available: 2026-W0/);

    // regenerating the tools while Toolbox is running does not break the next run
    const gen = (await client.callTool({ name: "generate_tools", arguments: {} })) as any;
    assert.ok(gen.structuredContent.tools > 40);
    const again = (await client.callTool({ name: "run_playbook", arguments: { name: "metric_change", inputs: { metric: "service_level", period: "2026-W07" } } })) as any;
    assert.equal(again.structuredContent.result.findings[0].value, "team_05");
  } finally {
    await client.close();
  }
});

test("the bundled plugin server works from a copy of the plugin directory", { skip: !enabled && "set CAUSELINE_INTEGRATION=1" }, async () => {
  const bundled = resolve(repo, "clients", "claude-code");
  if (!existsSync(resolve(bundled, "server", "causeline-mcp.mjs"))) assert.fail("run `npm run bundle:plugin` first");

  // an installed plugin is a copy, with nothing of the repo around it, so it is told where Toolbox is
  // (CAUSELINE_TOOLBOX), as a user would configure it
  const installed = resolve(mkdtempSync(resolve(tmpdir(), "plugin-copy-")), "causeline");
  cpSync(bundled, installed, { recursive: true });

  const pack = resolve(repo, "packs", "contact-centre");
  const c = loadCases(pack, ["call_surge_billing"])[0];
  const workDir = await prepareCase(pack, c, mkdtempSync(resolve(tmpdir(), "mcp-int-")), false);

  const client = new Client({ name: "integration", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(installed, "server", "causeline-mcp.mjs")],
      env: { ...process.env, CAUSELINE_PACK: workDir, CAUSELINE_PLAYBOOKS: resolve(installed, "playbooks"), CAUSELINE_TOOLBOX_URL: "", CAUSELINE_TOOLBOX: resolve(repo, process.platform === "win32" ? "toolbox.exe" : "toolbox") } as Record<string, string>,
      cwd: installed,
    }),
  );
  try {
    const list = (await client.callTool({ name: "list_playbooks", arguments: {} })) as any;
    assert.deepEqual(list.structuredContent.playbooks.map((p: any) => p.name).sort(), ["compare", "metric_change", "trend", "value"]);
    const res = (await client.callTool({ name: "run_playbook", arguments: { name: "metric_change", inputs: { metric: "calls_offered", period: "2026-W07" } } })) as any;
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.result.findings[0].value, "billing");
  } finally {
    await client.close();
  }
});

test("onboarding tools over stdio: seasonal data is detected, flat data is not, and the data checks pass", { skip: !enabled && "set CAUSELINE_INTEGRATION=1" }, async () => {
  const pack = resolve(repo, "packs", "contact-centre");
  const base = loadCases(pack, ["clean_week"])[0];

  async function onboardWith(setup: string) {
    const workDir = await prepareCase(pack, { ...base, setup }, mkdtempSync(resolve(tmpdir(), "mcp-onb-")), false);
    const client = new Client({ name: "integration", version: "0.0.1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(here, "..", "src", "main.js")],
        env: { ...process.env, CAUSELINE_PACK: workDir, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks") } as Record<string, string>,
      }),
    );
    try {
      const checks = (await client.callTool({ name: "check_data", arguments: {} })) as any;
      const analysis = (await client.callTool({ name: "analyze_seasonality", arguments: { metrics: ["service_level"] } })) as any;
      assert.equal(checks.isError, undefined, checks.content?.[0]?.text);
      assert.equal(analysis.isError, undefined, analysis.content?.[0]?.text);
      return { checks: checks.structuredContent, analysis: analysis.structuredContent };
    } finally {
      await client.close();
    }
  }

  const seasonal = await onboardWith("--seed 42");
  assert.equal(seasonal.checks.ok, true, JSON.stringify(seasonal.checks.checks.filter((c: any) => c.status === "fail")));
  assert.ok(seasonal.analysis.recommended.cycles.includes("weekday"), "the planted weekday pattern is found");
  assert.match(seasonal.analysis.recommended_block, /weekday/);
  const month = seasonal.analysis.results.find((r: any) => r.cycle === "month_of_year");
  assert.equal(month.status, "cannot_assess", "twelve weeks cannot test a yearly cycle, and the tool says so");

  const flat = await onboardWith("--seed 42 --no-seasonality");
  assert.deepEqual(flat.analysis.recommended.cycles, [], "flat data: no cycle is claimed");
});

test("route and scan_kpis over stdio: a plain question reaches the right expert, and a vague one scans every KPI", { skip: !enabled && "set CAUSELINE_INTEGRATION=1" }, async () => {
  const pack = resolve(repo, "packs", "contact-centre");
  const base = loadCases(pack, ["clean_week"])[0];
  const workDir = await prepareCase(pack, { ...base, setup: "--fault understaffed:team_05:wk7" }, mkdtempSync(resolve(tmpdir(), "mcp-route-")), false);
  const client = new Client({ name: "integration", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(here, "..", "src", "main.js")],
      env: { ...process.env, CAUSELINE_PACK: workDir, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks") } as Record<string, string>,
    }),
  );
  try {
    const asked = (await client.callTool({ name: "route", arguments: { question: "Why did service level drop in week 7?" } })) as any;
    assert.equal(asked.isError, undefined, asked.content?.[0]?.text);
    const r = asked.structuredContent;
    assert.equal(r.strategy, "expert");
    assert.deepEqual([r.options[0].kpi, r.options[0].task, r.options[0].expert, r.options[0].playbook, r.options[0].inputs.period], ["service_level", "deep_rca", "service-level-deep-rca", "metric_change", "2026-W07"]);
    assert.equal(r.options[0].status, "verified");
    assert.equal(r.needs, null);

    const missing = (await client.callTool({ name: "route", arguments: { question: "How was service level?" } })) as any;
    assert.equal(missing.structuredContent.needs.input, "period");

    const vague = (await client.callTool({ name: "route", arguments: { question: "Why was week 7 bad?" } })) as any;
    assert.equal(vague.structuredContent.strategy, "scan");
    const scan = (await client.callTool({ name: "scan_kpis", arguments: { period: vague.structuredContent.scan.period } })) as any;
    assert.equal(scan.isError, undefined, scan.content?.[0]?.text);
    assert.deepEqual(scan.structuredContent.kpis.map((k: any) => k.kpi).sort(), ["aht", "calls_offered", "service_level"]);
    assert.ok(Array.isArray(scan.structuredContent.moved));
  } finally {
    await client.close();
  }
});
