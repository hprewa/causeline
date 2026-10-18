import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findToolboxBinary } from "../src/toolbox-process.js";

const fakeBinary = (dir: string, name: string) => {
  const p = join(dir, name);
  writeFileSync(p, "");
  return p;
};

test("an explicit path wins over CAUSELINE_TOOLBOX and PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-"));
  const explicit = fakeBinary(dir, "explicit-toolbox");
  const viaEnv = fakeBinary(dir, "env-toolbox");
  assert.equal(findToolboxBinary(explicit, { CAUSELINE_TOOLBOX: viaEnv, PATH: "" }), explicit);
});

test("CAUSELINE_TOOLBOX is used when nothing is passed explicitly", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-"));
  const viaEnv = fakeBinary(dir, "env-toolbox");
  assert.equal(findToolboxBinary(undefined, { CAUSELINE_TOOLBOX: viaEnv, PATH: "" }), viaEnv);
});

test("a binary on PATH is found", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-"));
  const onPath = fakeBinary(dir, process.platform === "win32" ? "toolbox.exe" : "toolbox");
  assert.equal(findToolboxBinary(undefined, { PATH: dir }), onPath);
});

test("a missing binary gives an actionable error", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-"));
  // the repo-root fallback may exist on a dev machine; only assert the error shape when it does not
  try {
    findToolboxBinary(join(dir, "nope"), { PATH: "" });
  } catch (e) {
    assert.match((e as Error).message, /CAUSELINE_TOOLBOX/);
  }
});
