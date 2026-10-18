import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultGenerator, VERSION } from "../src/index.js";

test("VERSION matches package.json and ends up in the generator metadata", () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8"));
  assert.equal(VERSION, pkg.version);
  assert.equal(defaultGenerator().version, VERSION);
});
