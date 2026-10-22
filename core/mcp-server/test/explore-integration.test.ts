// Needs Python, DuckDB and the Toolbox binary: run with `npm run test:integration` (CAUSELINE_INTEGRATION=1). Skipped otherwise.
// The Explorer through the MCP server over stdio against a real Toolbox, with the truth worked out here from the raw CSV files
// and not by the system under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadCases, prepareCase } from "@causeline/eval";
import { Exploration } from "@causeline/schema";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const enabled = process.env.CAUSELINE_INTEGRATION === "1";

const csv = (file: string) => {
  const [head, ...lines] = readFileSync(file, "utf-8").trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
};

test("the Explorer answers five questions with the right numbers, labels every answer, writes its record, and refuses what it cannot do", { skip: !enabled && "set CAUSELINE_INTEGRATION=1", timeout: 300000 }, async () => {
  const pack = resolve(repo, "packs", "contact-centre");
  const c = loadCases(pack, ["understaffed_team"])[0];
  const workDir = await prepareCase(pack, c, mkdtempSync(resolve(tmpdir(), "mcp-explore-")), false);
  const calls = csv(join(workDir, "data", "raw", "calls.csv"));
  const teamOf = Object.fromEntries(csv(join(workDir, "data", "raw", "agents.csv")).map((a) => [a.agent, a.team]));

  // week 7 of the data starts 2026-02-16
  const week = calls.filter((r) => r.ts.slice(0, 10) >= "2026-02-16" && r.ts.slice(0, 10) <= "2026-02-22");
  const rateOf = (rows: typeof calls) => rows.reduce((a, r) => a + Number(r.answered_within_20s), 0) / rows.length;
  const teams = [...new Set(week.map((r) => teamOf[r.agent]))];
  const byTeam = Object.fromEntries(teams.map((t) => [t, week.filter((r) => teamOf[r.agent] === t)]));

  const client = new Client({ name: "integration", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(here, "..", "src", "main.js")], env: { ...process.env, CAUSELINE_PACK: workDir, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks") } as Record<string, string> }));
  const explore = async (args: Record<string, unknown>) => {
    const res = (await client.callTool({ name: "explore", arguments: args })) as any;
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    return res.structuredContent;
  };
  try {
    // 1. the lowest teams by service level in week 7: the planted fault is first, and its number is the CSV's
    const lowest = await explore({ op: "rank", kpi: "service_level", by: "team", period: "2026-W07", order: "lowest", top: 3, question: "Which team had the worst service level in week 7?" });
    assert.equal(lowest.label, "exploratory");
    assert.match(lowest.about_this_answer, /exploratory/);
    assert.equal(lowest.rows[0].node, "team_05");
    assert.ok(Math.abs(lowest.rows[0].value - rateOf(byTeam.team_05)) < 1e-6, `${lowest.rows[0].value} vs ${rateOf(byTeam.team_05)}`);
    assert.equal(lowest.rows[0].volume, byTeam.team_05.length);
    const exploration = lowest.exploration;

    // 2. calls by queue in week 7: the volumes are the CSV's counts
    const queues = await explore({ op: "breakdown", kpi: "calls_offered", by: "queue", period: "2026-W07" });
    assert.equal(queues.exploration, exploration, "the same exploration continues");
    for (const row of queues.rows) assert.equal(row.value, week.filter((r) => r.queue === row.node).length, row.node);
    assert.equal(queues.rows.reduce((a: number, r: any) => a + r.value, 0), week.length);

    // 3. one team's service level by day, for whole days
    const days = await explore({ op: "series", kpi: "service_level", level: "day", start_date: "2026-02-16", end_date: "2026-02-22", filters: { team: "team_05" } });
    assert.equal(days.rows.length, 7);
    for (const row of days.rows) assert.ok(Math.abs(row.value - rateOf(byTeam.team_05.filter((r) => r.ts.slice(0, 10) === row.from.slice(0, 10)))) < 1e-6, row.from);

    // 4. two teams side by side, with whether the difference is real
    const cmp = await explore({ op: "compare", kpi: "service_level", by: "team", nodes: ["team_05", "team_06"], period: "2026-W07" });
    assert.ok(Math.abs(cmp.rows.find((r: any) => r.label === "team_05").value - rateOf(byTeam.team_05)) < 1e-6);
    assert.equal(cmp.rows.find((r: any) => r.label === "more than chance explains").value, true);

    // 5. the same ranking against the week before: the biggest fall is the fault again
    const fall = await explore({ op: "rank", kpi: "service_level", by: "team", period: "2026-W07", against_period: "2026-W06", order: "biggest_fall", top: 1 });
    assert.equal(fall.rows[0].node, "team_05");
    assert.ok(fall.rows[0].change < -0.1);

    // what cannot be done is refused with a reason and what to do instead, and is part of the record
    const sql = await explore({ op: "cannot", kind: "free_sql", request: "select * from calls" });
    assert.equal(sql.refused.code, "free_sql");
    assert.match(sql.refused.instead, /Builder/);
    const unknown = await explore({ op: "breakdown", kpi: "revenue", by: "team", period: "2026-W07" });
    assert.equal(unknown.refused.code, "unknown_kpi");
    assert.match(unknown.refused.instead, /service level/);
    assert.equal((await explore({ op: "breakdown", kpi: "calls_offered", by: "team", period: "2026-W07", filters: { queue: "no_such_queue" } })).rows.length, 0);

    // the record on disk: valid, numbered, labelled, with the question and the trust in each KPI read
    const runs = join(workDir, "runs");
    const file = readdirSync(runs).find((f) => f === `exploration-${exploration}.json`);
    assert.ok(file && existsSync(join(runs, file)));
    const record = Exploration.parse(JSON.parse(readFileSync(join(runs, file), "utf-8")));
    assert.equal(record.question, "Which team had the worst service level in week 7?");
    assert.equal(record.label, "exploratory");
    assert.deepEqual(record.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(record.steps.filter((s) => s.refusal).length === 2);
    assert.ok(record.kpis.some((k) => k.kpi === "service_level"));
    assert.ok(record.steps.every((s) => s.queries === 0 || s.queries > 0), "queries are counted when the database reports them");

    // a new exploration starts when asked to
    const next = await explore({ op: "breakdown", kpi: "calls_offered", by: "queue", period: "2026-W07", new: true, question: "Calls by queue?" });
    assert.notEqual(next.exploration, exploration);
  } finally {
    await client.close();
  }
});
