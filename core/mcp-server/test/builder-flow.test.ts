// Needs Python and the Toolbox binary: run with `npm run test:integration` (CAUSELINE_INTEGRATION=1). Skipped otherwise.
// The Builder's whole path from raw CSV files to a verified expert, through the MCP server over stdio, as the
// causeline-build skill walks it. A script plays the model and the user; the user's numbers come from the raw files.
// The same path on BigQuery is scripts/bigquery-build-demo.mjs --example (it needs a Google Cloud project).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const enabled = process.env.CAUSELINE_INTEGRATION === "1";

test("raw files to a verified expert through the MCP tools, with the sign-off page agreeing with the chat", { skip: !enabled && "set CAUSELINE_INTEGRATION=1", timeout: 600000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "builder-flow-"));
  const py = process.env.CAUSELINE_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const gen = spawnSync(py, [join(repo, "packs", "contact-centre", "data", "generate.py"), "--fault", "understaffed:team_05:wk7", "--out-dir", join(dir, "raw")], { encoding: "utf-8" });
  assert.equal(gen.status, 0, gen.stderr);
  const files = readdirSync(join(dir, "raw")).filter((f) => f.endsWith(".csv")).map((f) => join(dir, "raw", f));
  const ws = join(dir, "workspace");

  const client = new Client({ name: "builder-flow", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(here, "..", "src", "main.js")],
      env: { ...process.env, CAUSELINE_PACK: ws, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), CAUSELINE_NO_BROWSER: "1" } as Record<string, string>,
    }),
  );
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as any;
    assert.equal(res.isError, undefined, `${name}: ${res.content?.[0]?.text}`);
    return res.structuredContent;
  };
  try {
    assert.match((await tool("build_status")).next, /Connect/);
    const connected = await tool("connect_files", { files });
    assert.equal(connected.tables.length, 2);
    const described = await tool("describe_data");
    assert.ok(described.hierarchies.some((h: { levels: string[] }) => h.levels.includes("team")));

    const ontology = parse(readFileSync(join(repo, "packs", "contact-centre", "ontology.yaml"), "utf-8"));
    const data = parse(readFileSync(join(repo, "packs", "contact-centre", "data.yaml"), "utf-8"));
    delete ontology.metrics.workload;
    delete data.source; // the connection's, not the agent's
    const saved = await tool("save_pack", { ontology, data, agents: [{ name: "service-level-deep-rca", kpi: "service_level", task: "deep_rca", examples: ["Why did service level drop?"] }] });
    assert.equal(saved.saved, true, saved.errors.join("; "));
    assert.ok((await tool("play_back", { confirm: true })).confirmed);

    // the person's numbers, from the raw files
    const csv = (f: string) => readFileSync(join(dir, "raw", f), "utf-8").trim().split(/\r?\n/).map((l) => l.split(","));
    const calls = csv("calls.csv").slice(1);
    const agents = csv("agents.csv");
    const centreOf = Object.fromEntries(agents.slice(1).map((a) => [a[agents[0].indexOf("agent")], a[agents[0].indexOf("centre")]]));
    const rate = (keep: (r: string[]) => boolean) => {
      const r = calls.filter(keep);
      return r.reduce((a, c) => a + Number(c[5]), 0) / r.length;
    };
    const inside = (w: { start: string; end: string }) => (r: string[]) => r[1].slice(0, 10) >= w.start && r[1].slice(0, 10) <= w.end;

    const proposed = await tool("propose_checks", { kpi: "service_level" });
    assert.ok(proposed.proposals.length >= 3);
    assert.ok(!/"got"/.test(JSON.stringify(proposed)), "no number of ours comes with the questions");
    const stored = () => JSON.parse(readFileSync(join(ws, "build.json"), "utf-8")).kpis.service_level.checks as { id: string; kind: string; scope: Record<string, string>; window: { start: string; end: string } }[];
    const total = stored().find((c) => c.kind === "total")!;
    const slice = stored().find((c) => c.kind === "slice" && c.scope.centre)!;

    const wrong = await tool("confirm_number", { kpi: "service_level", check: total.id, expected: 60, source: "the weekly report" });
    assert.equal(wrong.confirmed, false);
    const first = await tool("confirm_number", { kpi: "service_level", check: total.id, expected: rate(inside(total.window)), source: "the weekly report", tolerance: 0.001 });
    assert.equal(first.level, "provisional");
    assert.equal((await tool("verify_expert", { kpi: "service_level" })).verified, false, "one number is not enough");

    // the second number comes through the page, the way a person at the screen would give it
    const opened = await tool("open_signoff", { kpi: "service_level" });
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\//);
    const api = async (path: string, body?: unknown) => {
      const res = await fetch(`${new URL(opened.url).origin}${new URL(opened.url).pathname}api/${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
      return { status: res.status, json: (await res.json()) as any };
    };
    const centre = slice.scope.centre;
    await api("number", { kpi: "service_level", check: slice.id, expected: rate((r) => inside(slice.window)(r) && centreOf[r[2]] === centre), source: "the centre report" });
    const decided = await api("decide", { kpi: "service_level", check: slice.id, decision: "confirm" });
    assert.equal(decided.json.level, "verified", decided.json.gap);
    assert.equal((await tool("signoff_status", { kpi: "service_level" })).kpis[0].level, "verified", "the chat sees what the page did");

    await tool("add_incident", { kpi: "service_level", period: "2026-W07", finding: { dimension: "team", value: "team_05" }, question: "Why did service level drop in week 7?" });
    const verified = await tool("verify_expert", { kpi: "service_level" });
    assert.equal(verified.verified, true, verified.reasons.join("; "));
    assert.match((await tool("build_status")).next, /Take aht up the ladder/, "the next step is the next KPI that is not verified yet");

    // a change drops the KPI and its expert; the stored numbers bring it back
    const changed = JSON.parse(JSON.stringify(data));
    changed.metrics.service_level = { fact: "calls", numerator: "answered_within_20s * 1" };
    delete changed.source;
    await tool("save_pack", { ontology, data: changed });
    assert.equal((await tool("signoff_status", { kpi: "service_level" })).kpis[0].level, "provisional");
    const back = await tool("run_checks", { kpi: "service_level" });
    assert.equal(back.after, "verified", back.gap);
    assert.equal(back.restored, true);
  } finally {
    await client.close();
  }
});
