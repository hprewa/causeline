#!/usr/bin/env node
// Build a runnable copy of a synthetic pack (data generated with the given setup, loaded into SQLite).
//   node scripts/prepare-pack.mjs <pack dir> <work dir> [generator arguments, e.g. "--no-seasonality"]
// The work dir can then be used as --pack for `causeline run` or `causeline seasonality`.
import { resolve } from "node:path";
import { prepareSynthetic } from "../packs/_lib/synthetic-prepare.mjs";

const [pack, work, ...setup] = process.argv.slice(2);
if (!pack || !work) {
  console.error("usage: node scripts/prepare-pack.mjs <pack dir> <work dir> [generator arguments]");
  process.exit(2);
}
await prepareSynthetic({ setup: setup.join(" "), workDir: resolve(work), packDir: resolve(pack), reuse: false });
console.log(`prepared ${resolve(work)} (setup: ${setup.join(" ") || "default"})`);
