import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = dirname(fileURLToPath(import.meta.url));
const serverMain = resolve(here, "..", "src", "main.js");
const corePlaybooks = resolve(here, "..", "..", "..", "..", "playbooks");

// Neutral pack: the server is domain-free, so its tests are too.
const ONTOLOGY = `
time: { levels: [week, day], seasonality: none }
hierarchies: { h1: [a1, a2] }
dimensions: [d1]
metrics:
  m: { type: ratio, direction: higher_is_better, min_volume: 10 }
  total: { type: sum, direction: lower_is_better }
`;

const DATA = `
source: src
facts:
  events:
    sql: SELECT ts, a1, a2, d1, ok, amount FROM facts
    time: ts
    concepts: [a1, a2, d1]
metrics:
  m: { fact: events, numerator: ok }
  total: { fact: events, value: amount }
`;

function makePack(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-pack-"));
  mkdirSync(join(dir, "toolbox"));
  writeFileSync(join(dir, "ontology.yaml"), ONTOLOGY);
  writeFileSync(join(dir, "data.yaml"), DATA);
  writeFileSync(join(dir, "toolbox", "source.yaml"), "kind: source\nname: src\ntype: sqlite\ndatabase: data/x.db\n");
  return dir;
}

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const merged = { ...process.env, CAUSELINE_PLAYBOOKS: corePlaybooks, ...env } as Record<string, string>;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverMain], env: merged }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
  return res;
};

let client: Client;
let pack: string;

before(async () => {
  pack = makePack();
  client = await connect({ CAUSELINE_PACK: pack });
});
after(async () => {
  await client.close();
});

test("exposes exactly the causeline-mcp tools, with read-only hints where they apply", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["accept_sample", "access_help", "add_incident", "analyze_seasonality", "build_status", "calibrate", "calibration_status", "check_connection", "check_data", "check_setup", "confirm_number", "connect_bigquery", "connect_files", "cost_limit", "create_project", "describe_data", "discover_for_kpi", "explore", "generate_tools", "get_guide", "get_intent", "label_period", "list_playbooks", "list_projects", "open_project", "open_project_page", "open_signoff", "play_back", "project_summary", "propose_checks", "propose_incident", "recall", "reconcile_metric", "route", "run_checks", "run_intent", "run_playbook", "save_pack", "save_setup_card", "scan_kpis", "set_intent", "setup_card", "sign_in", "signoff_status", "start_over", "test_fact", "validate_pack", "verify_expert"]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.list_playbooks.annotations?.readOnlyHint, true);
  assert.equal(byName.generate_tools.annotations?.readOnlyHint, false);
  assert.equal(byName.analyze_seasonality.annotations?.readOnlyHint, true);
  assert.equal(byName.check_data.annotations?.readOnlyHint, true);
  assert.deepEqual((byName.run_playbook.inputSchema as any).required, ["name"]);
});

test("list_playbooks returns the core playbook and a summary of the ontology", async () => {
  const res = await call(client, "list_playbooks");
  assert.equal(res.isError, undefined);
  const out = res.structuredContent;
  assert.deepEqual(out.playbooks.map((p: any) => p.name).sort(), ["compare", "metric_change", "trend", "value"]);
  const change = out.playbooks.find((p: any) => p.name === "metric_change");
  assert.equal(change.source, "core");
  assert.deepEqual(Object.keys(change.inputs), ["metric", "period", "start_date", "end_date", "aggregation", "scope", "baseline"]);
  assert.equal(out.ontology.experts.length, 8, "a generic expert per KPI and task: 2 KPIs x 4 tasks");
  assert.ok(out.ontology.experts.every((e: any) => e.status === "draft"));
  assert.equal(out.ontology.period_level, "week");
  assert.deepEqual(out.ontology.hierarchies, { h1: ["a1", "a2"] });
  assert.deepEqual(out.ontology.metrics.map((m: any) => [m.name, m.type, m.supported]), [["m", "ratio", true], ["total", "sum", true]]);
  assert.ok(res.content[0].text.includes("metric_change"), "the same data is in the text content for clients without structured output");
});

test("validate_pack reports stale tools, generate_tools fixes it", async () => {
  const before = (await call(client, "validate_pack")).structuredContent;
  assert.equal(before.valid, true);
  assert.equal(before.generated_tools, "missing");
  assert.equal(before.data_checks, "run check_data");
  assert.ok(before.warnings.some((w: string) => /run generate_tools/.test(w)));
  assert.ok(before.warnings.some((w: string) => /"total" has no min_volume/.test(w)));

  const gen = (await call(client, "generate_tools")).structuredContent;
  assert.ok(gen.tools > 10);
  assert.ok(existsSync(gen.path));
  assert.deepEqual(gen.skipped_metrics, [], "sum metrics are generated now");

  const after = (await call(client, "validate_pack")).structuredContent;
  assert.equal(after.generated_tools, "fresh");
});

test("validate_pack reports a parse failure as data, not a crash", async () => {
  const bad = makePack();
  writeFileSync(join(bad, "ontology.yaml"), "entity: { table: t }\n");
  const c = await connect({ CAUSELINE_PACK: bad });
  try {
    const out = (await call(c, "validate_pack")).structuredContent;
    assert.equal(out.valid, false);
    assert.ok(out.errors.length > 0);
  } finally {
    await c.close();
  }
});

test("run_playbook rejects bad arguments and unknown playbooks with readable errors", async () => {
  const missingName = await call(client, "run_playbook", { inputs: {} });
  assert.equal(missingName.isError, true);
  assert.match(missingName.content[0].text, /name/);

  const unknown = await call(client, "run_playbook", { name: "does_not_exist", inputs: { metric: "m", period: "W1" } });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /playbook "does_not_exist" not found/);

  const badInput = await call(client, "run_playbook", { name: "metric_change", inputs: { metric: { nested: true } } });
  assert.equal(badInput.isError, true);
});

test("a server pointed at a directory with no ontology explains what to do", async () => {
  const empty = mkdtempSync(join(tmpdir(), "mcp-empty-"));
  const c = await connect({ CAUSELINE_PACK: empty });
  try {
    const res = await call(c, "list_playbooks");
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no description saved yet/);
  } finally {
    await c.close();
  }
});

test("the pack falls back to CLAUDE_PROJECT_DIR when CAUSELINE_PACK is empty (as a plugin config would leave it)", async () => {
  const c = await connect({ CAUSELINE_PACK: "", CLAUDE_PROJECT_DIR: pack });
  try {
    const res = await call(c, "list_playbooks");
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.pack, pack);
  } finally {
    await c.close();
  }
});

test("projects: with none open the tools say so; create and open switch what every tool works on; the last one opened comes back next time", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
  const env = { CAUSELINE_HOME: home, CAUSELINE_PACK: "", CLAUDE_PROJECT_DIR: "" };
  const c = await connect(env);
  try {
    const none = await call(c, "list_projects");
    assert.deepEqual([none.structuredContent.open, none.structuredContent.projects], [null, []]);
    const noPack = await call(c, "list_playbooks");
    assert.equal(noPack.isError, true);
    assert.match(noPack.content[0].text, /no project is open/);

    const alpha = await call(c, "create_project", { name: "Alpha" });
    assert.equal(alpha.structuredContent.created, "Alpha");
    assert.match(alpha.structuredContent.next, /Connect/);
    await call(c, "create_project", { name: "Beta" });
    const both = (await call(c, "list_projects")).structuredContent;
    assert.equal(both.open, "Beta");
    assert.deepEqual(both.projects.map((p: { name: string }) => p.name).sort(), ["Alpha", "Beta"]);
    assert.ok(!JSON.stringify(both).includes(home), "no folder path is handed to the model");

    assert.equal((await call(c, "open_project", { name: "alpha" })).structuredContent.opened, "Alpha");
    assert.equal((await call(c, "project_summary")).structuredContent.name, "Alpha");
    assert.equal((await call(c, "project_summary", { name: "Beta" })).structuredContent.name, "Beta");
    const unknown = await call(c, "open_project", { name: "Gamma" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /no project called "Gamma" \(there are: /);
    assert.equal((await call(c, "create_project", { name: "alpha" })).isError, true, "a name is used once");
  } finally {
    await c.close();
  }

  // a new session in the same home opens the project that was opened last
  const again = await connect(env);
  try {
    assert.equal((await call(again, "list_projects")).structuredContent.open, "Alpha");
  } finally {
    await again.close();
  }
});


test("setup_card and save_setup_card keep the prep card in the open project and say what to ask next", async () => {
  const empty = await call(client, "setup_card");
  assert.equal(empty.isError, undefined);
  assert.match(empty.structuredContent.next, /which one KPI/);
  const saved = await call(client, "save_setup_card", { kpi: "handle time", numbers: [{ period: "2026-W07", value: 410, source: "weekly report" }] });
  assert.equal(saved.isError, undefined);
  assert.match(saved.structuredContent.next, /how that KPI is worked out/);
  const again = await call(client, "setup_card");
  assert.equal(again.structuredContent.trusted_numbers[0].value, 410);
  assert.match(again.structuredContent.note, /not confirmed checks/);
  assert.equal((await call(client, "build_status")).structuredContent.steps[0].step, "prep card");
});

test("access_help writes the message to the administrator for a given project, and asks for the project when there is none", async () => {
  const none = await call(client, "access_help");
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /billed to/);
  const ok = await call(client, "access_help", { project: "my-billing", dataset: "d1", problem: "cannot_read_data" });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(ok.structuredContent.needs.map((n: any) => n.id), ["roles/bigquery.dataViewer"]);
  assert.match(ok.structuredContent.message, /on the dataset d1/);
});
