#!/usr/bin/env node
import { runGenerate } from "@causeline/generate";
import { runEvalCli } from "@causeline/eval";
import { runOnboardCli } from "@causeline/onboard";
import { buildStatus } from "@causeline/builder";
import { runRouteCli } from "@causeline/router";
import { runCli } from "@causeline/runner";

const USAGE = `usage: causeline <command> [options]
  generate --pack <dir>                       ontology.yaml -> Toolbox tools.generated.yaml
  run --pack <dir> --metric <m> --period <p>  run a playbook (default metric_change) and write result.json
  eval --pack <dir> [--agent claude-code]     score the pack's eval cases at runner level (and optionally agent level)
  route "<question>" --pack <dir>             which KPI, task and expert fit a plain question (needs the data)
  build status --pack <dir>                   where building a pack from a folder of files stands, and the next step
  seasonality --pack <dir> [--backtest]       onboarding: data checks, seasonality analysis and a recommended time.seasonality`;

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "generate") runGenerate(rest);
  else if (command === "run") await runCli(rest);
  else if (command === "route") await runRouteCli(rest);
  else if (command === "build" && rest[0] === "status") {
    const i = rest.indexOf("--pack");
    const status = buildStatus(i >= 0 ? rest[i + 1] : ".");
    for (const s of status.steps) console.log(`${s.done ? "[x]" : "[ ]"} ${s.step}: ${s.detail}`);
    console.log(`
next: ${status.next}`);
  }
  else if (command === "seasonality") await runOnboardCli(rest);
  else if (command === "eval") process.exitCode = await runEvalCli(rest);
  else {
    console.error(USAGE);
    process.exit(command ? 2 : 0);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
