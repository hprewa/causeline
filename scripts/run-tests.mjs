#!/usr/bin/env node
// Runs a package's compiled tests with `node --test`, listing the files itself: Node 20 accepts a directory,
// Node 22 does not, and glob patterns are not understood by every Node version or shell.
//   node ../../scripts/run-tests.mjs   (from a package directory; tests are in dist/test)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("dist", "test");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => join(dir, f)) : [];
if (files.length === 0) {
  console.error(`no compiled tests in ${dir}; run the build first`);
  process.exit(1);
}
process.exit(spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" }).status ?? 1);
