#!/usr/bin/env node
// Make a throw-away Codex home for a test run: the person's Codex sign-in copied in, Causeline installed through `causeline init`, their own
// Codex settings untouched. Prints the folder. The copy holds a sign-in token: delete the folder when the run is done.
//   node scripts/codex-home.mjs [--causeline-home <dir>]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");

export function makeCodexHome(causelineHome) {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  const auth = join(process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex"), "auth.json");
  if (!existsSync(auth)) throw new Error("no Codex sign-in found; run `codex login` first");
  writeFileSync(join(codexHome, "auth.json"), readFileSync(auth));
  const r = spawnSync(process.execPath, [join(repo, "bin", "causeline.mjs"), "init", "--client", "codex", "--no-check"], { env: { ...process.env, CODEX_HOME: codexHome, CAUSELINE_HOME: causelineHome }, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`could not install Causeline into Codex: ${r.stderr || r.stdout}`);
  return codexHome;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const i = process.argv.indexOf("--causeline-home");
  const home = i >= 0 ? resolve(process.argv[i + 1]) : mkdtempSync(join(tmpdir(), "causeline-home-"));
  console.log(JSON.stringify({ codexHome: makeCodexHome(home), causelineHome: home }));
}
