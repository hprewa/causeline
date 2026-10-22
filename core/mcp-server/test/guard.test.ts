import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const hook = resolve(repo, "clients", "claude-code", "hooks", "guard.mjs");
const { check, decision, RULES } = (await import(pathToFileURL(hook).href)) as { check: (c: string) => { blocked: boolean; rule?: string; reason?: string }; decision: (i: unknown) => any; RULES: { id: string }[] };

test("commands that reach the data by a side door are blocked, each with the rule that caught it", () => {
  const blocked: [string, string][] = [
    ["bq query --use_legacy_sql=false 'select 1'", "bq"],
    ["gcloud alpha bq query x", "bq"],
    ["sqlite3 data/x.db 'select * from calls'", "database_cli"],
    ["duckdb -c 'select 1'", "database_cli"],
    ["psql -h host -c 'select 1'", "database_cli"],
    ["cd work && sqlite3 x", "database_cli"],
    ["./toolbox.exe --tools-file x", "toolbox"],
    ["curl -s http://127.0.0.1:5000/api/tool/x/invoke", "toolbox_endpoint"],
    ["cat data/causeline.db | strings", "database_file"],
    ["python3 -c \"import sqlite3; sqlite3.connect('x').execute('select 1')\"", "inline_code"],
    ["node -e \"require('duckdb')\"", "inline_code"],
    ["python -c 'import pandas; pandas.read_sql(q, c)'", "inline_code"],
    ["Invoke-Sqlcmd -Query 'select 1'", "powershell_sql"],
  ];
  for (const [command, rule] of blocked) {
    const r = check(command);
    assert.equal(r.blocked, true, command);
    assert.equal(r.rule, rule, command);
    assert.match(r.reason!, /explore/, "it says what to do instead");
  }
});

test("ordinary commands, and mentions of these words in text, are not blocked", () => {
  for (const command of [
    "ls -la",
    "git status",
    "git commit -m \"note about sqlite3 and bq query\"",
    "echo 'use duckdb later'",
    "npm test",
    "node scripts/toolbox.mjs packs/x 5000",
    "python3 script.py --seed 3",
    "cat README.md",
    "grep -rn bigquery docs",
    "cd toolbox/ && ls",
    "",
  ]) {
    assert.equal(check(command).blocked, false, command);
  }
  assert.equal(check(undefined as never).blocked, false);
});

test("the hook answers in the form Claude Code reads, and stays out of the way of anything it cannot read", () => {
  assert.deepEqual(decision({ tool_name: "Bash", tool_input: { command: "ls" } }), {});
  const d = decision({ tool_name: "Bash", tool_input: { command: "sqlite3 x.db" } });
  assert.equal(d.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(d.hookSpecificOutput.permissionDecision, "deny");
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /database command line/);
  const run = (stdin: string) => spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf-8" });
  assert.equal(JSON.parse(run(JSON.stringify({ tool_input: { command: "duckdb" } })).stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(JSON.parse(run("not json").stdout), {});
  assert.deepEqual(JSON.parse(run("").stdout), {});
});

test("the plugin registers the hook for shell commands, and every rule has a test above", () => {
  const hooks = JSON.parse(readFileSync(resolve(repo, "clients", "claude-code", "hooks", "hooks.json"), "utf-8"));
  const entry = hooks.hooks.PreToolUse[0];
  assert.match(entry.matcher, /Bash/);
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guard\.mjs/);
  const tested = new Set(["bq", "database_cli", "toolbox", "toolbox_endpoint", "database_file", "inline_code", "powershell_sql"]);
  assert.deepEqual(RULES.map((r) => r.id).sort(), [...tested].sort());
});
