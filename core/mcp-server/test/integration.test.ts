// Needs Python, DuckDB and the Toolbox binary, and takes about ten seconds: run with
// `npm run test:integration` (which sets CAUSELINE_INTEGRATION=1). Skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadCases, prepareCase } from "@causeline/eval";
import { parseSkill } from "../src/guides.js";

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
    assert.equal(r.options[0].status, "reconciled");
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

test("a question built over several messages: ask, confirm, run, refine, switch topic, recall, start over", { skip: !enabled && "set CAUSELINE_INTEGRATION=1" }, async () => {
  const pack = resolve(repo, "packs", "contact-centre");
  const base = loadCases(pack, ["clean_week"])[0];
  const workDir = await prepareCase(pack, { ...base, setup: "--fault understaffed:team_05:wk7" }, mkdtempSync(resolve(tmpdir(), "mcp-intent-")), false);
  const client = new Client({ name: "integration", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(here, "..", "src", "main.js")],
      env: { ...process.env, CAUSELINE_PACK: workDir, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks") } as Record<string, string>,
    }),
  );
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as any;
    assert.equal(res.isError, undefined, `${name}: ${res.content?.[0]?.text}`);
    return res.structuredContent;
  };
  try {
    const bundle = await tool("get_intent");
    assert.equal(bundle.data_covers.end, "2026-03-15");
    assert.deepEqual(bundle.kpis.map((k: any) => k.name).sort(), ["aht", "calls_offered", "service_level", "workload"]);

    // nothing is run before the question is complete
    assert.equal((await tool("run_intent")).ran, false);

    let r = await tool("set_intent", { message: "how is the SLA doing?", patch: { kpi: "SLA" } });
    assert.equal(r.check.status, "ask");
    assert.equal(r.check.slot, "task");
    r = await tool("set_intent", { message: "why did it drop in the week of 16 February?", patch: { task: "deep_rca", period: { kind: "range", start: "2026-02-16", end: "2026-02-22" } } });
    assert.equal(r.check.status, "ready", JSON.stringify(r.check));
    assert.match(r.check.playback, /deep dive into service level for 16–22 February 2026/);

    const first = await tool("run_intent");
    assert.equal(first.ran, true);
    assert.equal(first.n, 1);
    assert.equal(first.result.findings[0].value, "team_05", "found by date range, not by label");
    assert.equal(first.result.inputs.start_date, "2026-02-16");
    // every answer says how sure it is, from the run and the expert's rung; this pack's experts are verified-by-construction packs, so the ceiling is what the evidence gives
    assert.ok(["high", "moderate", "low"].includes(first.confidence.label), JSON.stringify(first.confidence));
    assert.ok(first.confidence.because.length >= 2, "the reasons are in words");
    assert.match(first.notes.join(" "), /Say how sure the answer is/);

    // refine: a team that is not quite a team name is offered, not guessed; then the run is confined to it
    r = await tool("set_intent", { message: "just team 5", patch: { filters: { team: "tem 05" } } });
    assert.equal(r.check.status, "ask");
    assert.deepEqual(r.check.options.map((o: any) => o.value), ["team_05"]);
    r = await tool("set_intent", { message: "yes", patch: { filters: { team: "team_05" } } });
    assert.equal(r.check.status, "ready");
    const scoped = await tool("run_intent");
    assert.equal(scoped.result.inputs.scope, '{"team":"team_05"}');
    assert.ok(scoped.result.headline.change < first.result.headline.change, "the team on its own is worse than everyone");

    // a new KPI carries the rest over, and says so
    r = await tool("set_intent", { message: "and call volume?", patch: { kpi: "call volume", filters: { team: null } } });
    assert.equal(r.topic_switch.to, "calls_offered");
    assert.ok(r.topic_switch.kept.includes("the same period"));

    // go back to the first answer and compare instead
    const back = await tool("recall", { n: 1 });
    assert.equal(back.active.kpi, "service_level");
    assert.deepEqual(back.active.filters, {});
    r = await tool("set_intent", { message: "compare with the week before", patch: { task: "compare", period: { kind: "relative", unit: "week" }, comparison: "previous" } });
    assert.equal(r.check.status, "ready", JSON.stringify(r.check));
    const cmp = await tool("run_intent");
    assert.equal(cmp.ran, true);
    assert.equal(cmp.result.playbook, "compare");

    // a comparison that is not whole weeks of the data says so instead of guessing
    await tool("set_intent", { patch: { period: { kind: "relative", unit: "day", offset: 1, count: 5 } } });
    const odd = await tool("run_intent");
    assert.equal(odd.ran, false);
    assert.match(odd.cannot, /whole weeks of the data/);

    const history = await tool("recall");
    assert.equal(history.history.length, 3);
    const fresh = await tool("start_over");
    assert.deepEqual(fresh.active, { filters: {} });
    assert.equal(fresh.history_kept, 3);

    // movement over several weeks, by week
    await tool("set_intent", { patch: { kpi: "aht", task: "trend", period: { kind: "relative", unit: "week", offset: 1, count: 4 }, aggregation: "weekly" } });
    const trend = await tool("run_intent");
    assert.equal(trend.ran, true, JSON.stringify(trend.check ?? trend.cannot));
    assert.equal(trend.result.playbook, "trend");
    assert.equal(trend.result.status, "complete", trend.result.stopped_detail);

    const conn = await tool("check_connection");
    assert.equal(conn.ok, true);
  } finally {
    await client.close();
  }
});

/** A skill file without its front matter, the way the guides are served. */
const bodyOf = (raw: string) => parseSkill(raw).body;

test("the bundled server alone, with no skills folder beside it, still serves every guide, and they are the skills' text", { skip: !enabled && "set CAUSELINE_INTEGRATION=1" }, async () => {
  const bundled = resolve(repo, "clients", "claude-code", "server", "causeline-mcp.mjs");
  if (!existsSync(bundled)) assert.fail("run `npm run bundle:plugin` first");
  const lone = resolve(mkdtempSync(resolve(tmpdir(), "lone-server-")), "causeline-mcp.mjs");
  cpSync(bundled, lone);
  const client = new Client({ name: "integration", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [lone], env: { ...process.env, CAUSELINE_PACK: "", CLAUDE_PROJECT_DIR: "", CAUSELINE_SKILLS: "", CAUSELINE_HOME: mkdtempSync(resolve(tmpdir(), "lone-home-")) } as Record<string, string> }));
  try {
    for (const name of ["build", "investigate", "explore", "onboard"]) {
      const res = (await client.callTool({ name: "get_guide", arguments: { name } })) as any;
      assert.equal(res.isError, undefined, res.content?.[0]?.text);
      const skill = bodyOf(readFileSync(resolve(repo, "skills", `causeline-${name}`, "SKILL.md"), "utf-8"));
      assert.equal(res.structuredContent.text, skill, `${name} in the bundle is the skill's text`);
    }
    assert.equal(((await client.listResources()).resources ?? []).length, 4);
  } finally {
    await client.close();
  }
});

