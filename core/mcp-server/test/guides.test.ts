import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { getGuide, GUIDE_NAMES, loadGuides, parseSkill } from "../src/guides.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const skill = (n: string) => readFileSync(resolve(repo, "skills", `causeline-${n}`, "SKILL.md"), "utf-8");

test("every guide is its skill's own text, without the front matter, so the two cannot drift", () => {
  const guides = loadGuides();
  assert.deepEqual(guides.map((g) => g.name), [...GUIDE_NAMES]);
  for (const g of guides) {
    const s = parseSkill(skill(g.name));
    assert.equal(g.text, s.body, g.name);
    assert.ok(g.text.length > 800, `${g.name} has its body`);
    assert.ok(!g.text.startsWith("---"), "no front matter");
    assert.ok(g.when.length > 40, `${g.name} says when to use it`);
  }
});

test("get_guide lists the guides with when each applies, returns one by name, and refuses an unknown name", () => {
  const list = getGuide(undefined) as { guides: { name: string; when: string }[] };
  assert.deepEqual(list.guides.map((g) => g.name), ["build", "investigate", "explore", "onboard"]);
  assert.match(list.guides.find((g) => g.name === "explore")!.when, /no expert covers/);
  const one = getGuide("investigate") as { guide: string; text: string };
  assert.equal(one.guide, "investigate");
  assert.match(one.text, /Investigating a metric change/);
  assert.throws(() => getGuide("nope"), /no guide called "nope".*build, investigate, explore, onboard/);
});

test("front matter is split from the body, and a file without it is all body", () => {
  const s = parseSkill("---\nname: x\ndescription: Does a thing.\nwhen_to_use: Often.\n---\n\n# Title\nBody.\n");
  assert.deepEqual([s.description, s.when_to_use, s.body], ["Does a thing.", "Often.", "# Title\nBody.\n"]);
  assert.equal(parseSkill("no front matter").body, "no front matter");
});

test("over stdio the server teaches the client to ask for the guide, lists it as a tool and as resources, and serves the same text", async () => {
  const client = new Client({ name: "guides", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(here, "..", "src", "main.js")], env: { ...process.env, CAUSELINE_PACK: "", CLAUDE_PROJECT_DIR: "", CAUSELINE_HOME: resolve(repo, "runs", "guides-test-home") } as Record<string, string> }));
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /call get_guide with the name that fits/);
    assert.match(instructions, /never write SQL or run a database command/);
    assert.match(instructions, /call check_setup/);
    assert.match(instructions, /call list_projects/);
    const res = (await client.callTool({ name: "get_guide", arguments: { name: "explore" } })) as any;
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.text, parseSkill(skill("explore")).body);
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri).sort(), GUIDE_NAMES.map((n) => `causeline://guide/${n}`).sort());
    const read = await client.readResource({ uri: "causeline://guide/build" });
    assert.equal((read.contents[0] as { text: string }).text, parseSkill(skill("build")).body);
  } finally {
    await client.close();
  }
});
