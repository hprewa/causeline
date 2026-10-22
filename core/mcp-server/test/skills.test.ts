import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const serverSource = readFileSync(resolve(repo, "core", "mcp-server", "src", "server.ts"), "utf-8");
const registered = new Set([...serverSource.matchAll(/(?:builder|registerTool)\(\s*"([a-z_]+)"/g)].map((m) => m[1]));

test("every tool the build skill names exists, and the sign-off tools are all taught", () => {
  const skill = readFileSync(resolve(repo, "skills", "causeline-build", "SKILL.md"), "utf-8");
  const named = new Set([...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]));
  const tools = [...named].filter((n) => registered.has(n));
  for (const must of ["build_status", "play_back", "propose_checks", "confirm_number", "open_signoff", "run_checks", "verify_expert", "list_projects", "create_project", "open_project", "open_project_page"]) assert.ok(tools.includes(must), `the skill never names ${must}`);
});

test("the skill no longer teaches that one matched number makes a KPI matched", () => {
  const skill = readFileSync(resolve(repo, "skills", "causeline-build", "SKILL.md"), "utf-8");
  assert.ok(!/is "matched" only after/.test(skill));
  assert.match(skill, /at least three numbers/);
  assert.match(skill, /Ask before you show anything of ours/);
  assert.match(skill, /gcloud auth application-default login/);
});

test("the explore skill names the tool and its operations, carries the label, and forbids SQL; the investigate skill points to it", () => {
  const skill = readFileSync(resolve(repo, "skills", "causeline-explore", "SKILL.md"), "utf-8");
  const named = new Set([...skill.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map((m) => m[1]));
  for (const must of ["explore", "route", "open_project_page", "breakdown", "rank", "series", "compare", "profile", "cannot", "free_sql"]) assert.ok(named.has(must), `the skill never names ${must}`);
  assert.ok([...named].filter((n) => /_/.test(n)).every((n) => registered.has(n) || ["free_sql", "unknown_kpi", "about_this_answer", "against_period", "against_start", "against_end", "start_date", "end_date"].includes(n)), "every tool it names exists");
  assert.match(skill, /exploratory/);
  assert.match(skill, /Never write or suggest SQL/);
  assert.match(skill, /No claim about cause/);
  assert.match(readFileSync(resolve(repo, "skills", "causeline-investigate", "SKILL.md"), "utf-8"), /causeline-explore/);
  assert.match(serverSource, /causeline-explore skill/);
  assert.ok(registered.has("explore"));
});

