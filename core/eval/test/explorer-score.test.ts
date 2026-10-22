import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadCases } from "../src/cases.js";
import { scoreAgent, untracedAgainst } from "../src/score.js";
import { renderTable, runnerOk, type CaseOutcome } from "../src/table.js";
import { parseStream } from "../src/agent.js";
import type { Expectation } from "@causeline/schema";

const pack = resolve("..", "..", "packs", "contact-centre");
const expect_: Expectation = { must_mention: ["team_05"], explorer: { labelled: true, rows_include: ["team_05"], no_shell: true } };
const answer = (rows: unknown[], extra: object = {}) => ({ label: "exploratory", rows, asked: "lowest 3 team", says: "The 3 team values.", notes: [], ...extra });
const ev = (narrative: string, explored: unknown[], toolCalls: { name: string; input: unknown }[] = [{ name: "mcp__plugin_x__causeline-mcp__explore", input: {} }]) => ({ narrative, toolCalls, result: null, explored, question: "Which team had the worst service level in week 7?", expectedPlaybook: "metric_change" });

test("an Explorer answer passes when it used the tool, said exploratory, quoted only rows, and ran no shell", () => {
  const rows = [{ rank: 1, node: "team_05", value: 0.535, volume: 1500 }];
  const ok = scoreAgent(ev("This is exploratory: team_05 had the lowest service level, 53.5% on 1500 calls.", [answer(rows)]), expect_);
  assert.equal(ok.pass, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
});

test("each way it can go wrong is caught on its own", () => {
  const rows = [{ rank: 1, node: "team_05", value: 0.535, volume: 1500 }];
  const names = (narrative: string, explored: unknown[], calls?: { name: string; input: unknown }[]) => scoreAgent(ev(narrative, explored, calls), expect_).checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(names("team_05 had the lowest service level, 53.5%.", [answer(rows)]), ["says_exploratory"]);
  assert.deepEqual(names("Exploratory: team_05 was lowest at 61.2%.", [answer(rows)]), ["numbers_traceable"]);
  assert.ok(names("Exploratory: team_05 lowest.", [answer(rows, { label: "checked" })]).includes("labelled_by_the_tool"));
  assert.ok(names("Exploratory: team_05 lowest.", [answer([{ node: "team_09" }])]).includes("rows_include:team_05"));
  assert.ok(names("Exploratory: team_05.", [], [{ name: "run_playbook", input: {} }]).includes("explore_called"));
  assert.deepEqual(names("Exploratory: team_05.", [answer(rows)], [{ name: "x__explore", input: {} }, { name: "Bash", input: { command: "sqlite3 x" } }]), ["no_shell"]);
});

test("a refusal is scored on what the tool said, and need not be called exploratory", () => {
  const e: Expectation = { must_mention: ["Builder"], explorer: { labelled: false, refused: "free_sql", no_shell: true } };
  const refused = { label: "exploratory", rows: [], refused: { code: "free_sql" } };
  assert.equal(scoreAgent(ev("I can't run SQL; describe it as a KPI with the Builder.", [refused]), e).pass, true);
  assert.equal(scoreAgent(ev("Here you go: 42.", [answer([])]), e).pass, false);
});

test("numbers are traced to the rows and the question, in the percentage form too", () => {
  assert.deepEqual(untracedAgainst("It was 53.5% across 1,500 rows in week 7.", [[{ value: 0.535, volume: 1500 }]], "week 7"), []);
  assert.deepEqual(untracedAgainst("It was 62%.", [[{ value: 0.535 }]], "q"), ["62"]);
});

test("the stream parser keeps what each explore call answered", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__plugin_c__causeline-mcp__explore", input: { op: "rank" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: JSON.stringify({ label: "exploratory", rows: [{ node: "a" }] }) }] }] } }),
    JSON.stringify({ type: "result", result: "Exploratory: a.", subtype: "success", num_turns: 2 }),
  ];
  const run = parseStream(lines);
  assert.equal(run.explored.length, 1);
  assert.equal(run.explored[0].rows[0].node, "a");
});

test("the explorer cases load, are agent-only, and do not make a runner-level run fail", () => {
  const cases = loadCases(pack, undefined, "explorer");
  assert.deepEqual(cases.map((c) => c.id), ["explore_worst_team", "explore_calls_by_queue", "explore_busiest_agents", "explore_one_team_by_day", "explore_sql_is_refused"]);
  assert.ok(cases.every((c) => c.inputs === undefined && c.expect.explorer));
  const outcome: CaseOutcome = { id: "x", agentOnly: true, runner: { error: "no inputs" }, runnerMs: 0, steps: 0 };
  assert.equal(runnerOk(outcome), true);
  assert.match(renderTable([outcome], false), /runner score: 0\/0/);
  assert.doesNotMatch(renderTable([outcome], false), /ERROR/);
  assert.throws(() => loadCases(pack, undefined, "../cases"), /not the name of a file of cases/);
});
