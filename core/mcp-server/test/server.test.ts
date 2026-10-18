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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["add_incident", "analyze_seasonality", "build_status", "check_data", "connect_files", "describe_data", "generate_tools", "list_playbooks", "play_back", "reconcile_metric", "route", "run_playbook", "save_pack", "scan_kpis", "test_fact", "validate_pack", "verify_expert"]);
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
  assert.deepEqual(Object.keys(change.inputs), ["metric", "period", "baseline"]);
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
    assert.match(res.content[0].text, /CAUSELINE_PACK/);
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
