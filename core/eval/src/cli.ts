#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defaultWorkRoot, runEvals } from "./run.js";
import { renderIntents, runIntentEval } from "./intents.js";
import { renderRouting, runRoutingEval } from "./routing.js";
import { renderTable, runnerOk } from "./table.js";
import { branchCoverage, expertsWithUntestedBranches, renderCoverage } from "./branches.js";

const USAGE = `usage: causeline eval --pack <dir> [options]
  --case <id[,id...]>     run only these cases
  --agent claude-code     also ask each case's question to a live agent (costs money; never run in CI)
  --plugin-dir <dir>      the plugin to give the agent (default: clients/claude-code)
  --no-bare               let the agent use your own Claude Code login and settings (default is --bare, which needs ANTHROPIC_API_KEY)
  --model <name>          model for the agent
  --max-turns <n>         agent turn limit (default 12)
  --routing               score the pack's routing eval (evals/routing.yaml) instead of its cases; needs at least 90%
  --intents               score the pack's intent eval (evals/intents.yaml): conversations to resolved intents; needs all of them (add --agent claude-code for a live attempt at each)
  --require-branches      fail the run when an expert marked verified has a playbook branch that no passing case takes
  --reuse                 reuse a case's prepared pack when its setup has not changed
  --toolbox <path>        Toolbox binary (default: CAUSELINE_TOOLBOX, PATH, or ./toolbox.exe)
  --work-dir <dir>        where per-case packs are built (default: runs/eval-work/<pack name>)
  --out-dir <dir>         where the JSON results go (default: runs/evals)`;

/** Parse `--flag value` pairs and bare switches. */
function parse(argv: string[]): { flags: Map<string, string>; switches: Set<string> } {
  const switches = new Set(["reuse", "no-bare", "routing", "intents", "require-branches"]);
  const flags = new Map<string, string>();
  const on = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument "${key}"\n${USAGE}`);
    const name = key.slice(2);
    if (switches.has(name)) on.add(name);
    else {
      if (argv[i + 1] === undefined) throw new Error(`--${name} needs a value\n${USAGE}`);
      flags.set(name, argv[++i]);
    }
  }
  return { flags, switches: on };
}

export async function runEvalCli(argv: string[]): Promise<number> {
  const { flags, switches } = parse(argv);
  const pack = flags.get("pack");
  if (!pack) {
    console.error(USAGE);
    return 2;
  }
  if (switches.has("routing")) {
    const outcomes = await runRoutingEval({ packDir: resolve(pack), workRoot: resolve(flags.get("work-dir") ?? join(defaultWorkRoot(), basename(resolve(pack)))), toolbox: flags.get("toolbox"), log: (l) => console.error(l) });
    console.log(renderRouting(outcomes));
    return outcomes.filter((o) => o.pass).length / Math.max(1, outcomes.length) >= 0.9 ? 0 : 1;
  }
  if (switches.has("intents")) {
    const withAgent = flags.get("agent");
    if (withAgent && withAgent !== "claude-code") throw new Error(`unknown agent "${withAgent}" (only claude-code is supported)`);
    const outcomes = await runIntentEval({
      packDir: resolve(pack),
      workRoot: resolve(flags.get("work-dir") ?? join(defaultWorkRoot(), basename(resolve(pack)))),
      toolbox: flags.get("toolbox"),
      only: flags.get("case")?.split(","),
      log: (l) => console.error(l),
      ...(withAgent ? { agent: { pluginDir: resolve(flags.get("plugin-dir") ?? join("clients", "claude-code")), bare: !switches.has("no-bare"), model: flags.get("model"), maxTurns: Number(flags.get("max-turns") ?? 20), timeoutMs: 10 * 60 * 1000 } } : {}),
    });
    console.log(renderIntents(outcomes));
    if (withAgent) {
      const dir = resolve(flags.get("out-dir") ?? join("runs", "evals"));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `intents-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeFileSync(file, JSON.stringify(outcomes, null, 2) + "\n", "utf-8");
      console.log(`results: ${file}`);
    }
    return outcomes.every((o) => o.pass && (!o.agent || o.agent.pass)) ? 0 : 1;
  }
  const agentName = flags.get("agent");
  if (agentName && agentName !== "claude-code") throw new Error(`unknown agent "${agentName}" (only claude-code is supported)`);

  const outcomes = await runEvals({
    packDir: resolve(pack),
    only: flags.get("case")?.split(","),
    // per pack: two packs can have a case with the same id, and must not share a directory
    workRoot: resolve(flags.get("work-dir") ?? join(defaultWorkRoot(), basename(resolve(pack)))),
    reuse: switches.has("reuse"),
    toolbox: flags.get("toolbox"),
    log: (l) => console.error(l),
    ...(agentName
      ? {
          agent: {
            pluginDir: resolve(flags.get("plugin-dir") ?? join("clients", "claude-code")),
            bare: !switches.has("no-bare"),
            model: flags.get("model"),
            maxTurns: Number(flags.get("max-turns") ?? 12),
            timeoutMs: 10 * 60 * 1000,
          },
        }
      : {}),
  });

  console.log("\n" + renderTable(outcomes, !!agentName));
  const outDir = resolve(flags.get("out-dir") ?? join("runs", "evals"));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(outcomes, null, 2) + "\n", "utf-8");
  console.log(`\nresults: ${file}`);

  const runnerFailed = outcomes.some((o) => !runnerOk(o));
  // which branches of the playbooks the cases take; only meaningful when every case ran
  let branchesFailed = false;
  if (!flags.get("case")) {
    const coverage = branchCoverage(outcomes, resolve(pack));
    const flagged = expertsWithUntestedBranches(coverage, resolve(pack));
    if (coverage.length > 0) console.log("\n" + renderCoverage(coverage, flagged));
    branchesFailed = switches.has("require-branches") && flagged.length > 0;
  }
  return runnerFailed || branchesFailed ? 1 : 0;
}

if (process.argv[1] && /cli\.js$/.test(process.argv[1])) {
  runEvalCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
