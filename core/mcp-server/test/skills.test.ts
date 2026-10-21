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
