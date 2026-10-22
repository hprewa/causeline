import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolboxInstaller, type ToolboxBuild } from "@causeline/runner";
import { setupCheck } from "../src/setup-check.js";
import { ToolboxManager } from "../src/toolbox.js";
import type { ServerConfig } from "../src/config.js";

const here = `${process.platform}-${process.arch}`;
const build: ToolboxBuild = { key: here, url: "http://127.0.0.1:1/never", size: 10, sha256: "0".repeat(64), file: "toolbox" };
const cfg = (home: string): ServerConfig => ({ packDir: "", runsDir: "", home });
const missing = () => {
  throw new Error("not found");
};

test("the first use of the data connection, with nothing on the machine, starts the download and says so in plain words instead of failing", async () => {
  const home = mkdtempSync(join(tmpdir(), "setup-"));
  const installer = new ToolboxInstaller({ home, builds: { [here]: build } });
  const manager = new ToolboxManager({ ...cfg(home), packDir: home }, installer, missing);
  await assert.rejects(manager.caller(), /preparing the data connection for the first time/);
  assert.notEqual(installer.status().state, "idle", "the download was started");
  await manager.stop();
});

test("a machine with no build says so, and where the program is already on the machine nothing is fetched", async () => {
  const home = mkdtempSync(join(tmpdir(), "setup-"));
  const unsupported = new ToolboxManager({ ...cfg(home), packDir: home }, new ToolboxInstaller({ home, platform: "linux", arch: "arm64" }), missing);
  await assert.rejects(unsupported.caller(), /no ready-made data connection for this computer \(linux, arm64\)/);
  const installer = new ToolboxInstaller({ home, builds: { [here]: build } });
  const present = new ToolboxManager({ ...cfg(home), packDir: home }, installer, () => "/somewhere/toolbox");
  await assert.rejects(present.caller(), (e: Error) => !/preparing the data connection/.test(e.message), "it tried to start the found program, not to fetch");
  assert.equal(installer.status().state, "idle");
});

test("the setup check says each thing in one plain line, starts the download when it is missing, and never shows a path", async () => {
  const home = mkdtempSync(join(tmpdir(), "setup-"));
  const installer = new ToolboxInstaller({ home, builds: { [here]: build } });
  const r = await setupCheck({ ...cfg(home), toolboxBinary: join(home, "nope") }, installer, { locate: missing });
  assert.equal(r.checks[0].id, "version");
  assert.equal(r.checks.find((c) => c.id === "projects_folder")!.ok, true);
  const conn = r.checks.find((c) => c.id === "data_connection")!;
  assert.match(conn.say, /(preparing the data connection|could not fetch)/);
  assert.ok(conn.todo);
  assert.equal(r.checks.find((c) => c.id === "project")!.say, "No project is open yet: ask me to start one, or to open one of yours.");
  assert.ok(!JSON.stringify(r).includes(home), "no folder path in the report");
  assert.equal(r.ready, r.checks.every((c) => c.ok));
});

test("the setup check says when the folder cannot be written, and reports the sign-in when it is asked to", async () => {
  const home = mkdtempSync(join(tmpdir(), "setup-"));
  const blocker = join(home, "afile");
  writeFileSync(blocker, "x");
  const installer = new ToolboxInstaller({ home, builds: { [here]: build } });
  const r = await setupCheck({ ...cfg(join(blocker, "inside")), toolboxUrl: "http://127.0.0.1:5000" }, installer, { openProject: "Weekly review", signIn: async () => ({ ok: false, summary: "You are not signed in to Google Cloud." }), locate: missing });
  assert.equal(r.checks.find((c) => c.id === "projects_folder")!.ok, false);
  assert.match(r.checks.find((c) => c.id === "projects_folder")!.todo!, /CAUSELINE_HOME/);
  assert.equal(r.checks.find((c) => c.id === "data_connection")!.ok, true, "a running Toolbox is enough");
  assert.equal(r.checks.find((c) => c.id === "sign_in")!.ok, false);
  assert.match(r.checks.find((c) => c.id === "project")!.say, /"Weekly review" is open/);
  assert.equal(r.ready, false);
  assert.match(r.summary, /not signed in/);
});
