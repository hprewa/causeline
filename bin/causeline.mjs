#!/usr/bin/env node
// `causeline init ...` sets Causeline up in an AI client; every other command is the analysis command line.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const [command, ...rest] = process.argv.slice(2);
if (command === "init") {
  const { init } = await import(pathToFileURL(join(root, "scripts", "init.mjs")).href);
  try {
    process.exit(await init(rest));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
} else {
  await import(pathToFileURL(join(root, "core", "cli", "dist", "src", "main.js")).href);
}
