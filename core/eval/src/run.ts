import { join } from "node:path";
import { findToolboxBinary, loadPackForRun, loadPlaybook, runPlaybook, SdkToolCaller, ToolboxProcess } from "@causeline/runner";
import type { EvalCase } from "@causeline/schema";
import { runClaudeCode } from "./agent.js";
import { loadCases } from "./cases.js";
import { prepareCase } from "./prepare.js";
import { scoreAgent, scoreRunner } from "./score.js";
import type { CaseOutcome } from "./table.js";

export interface AgentConfig {
  pluginDir: string;
  bare: boolean;
  model?: string;
  maxTurns: number;
  timeoutMs: number;
}

export interface EvalOptions {
  packDir: string;
  only?: string[];
  /** Where per-case packs are built (one subdirectory per case). */
  workRoot: string;
  reuse: boolean;
  toolbox?: string;
  /** Present to also run each case through a live agent. */
  agent?: AgentConfig;
  log?: (line: string) => void;
  /** Where the core playbooks are (a bundled server cannot find them relative to itself). */
  corePlaybooksDir?: string;
}

async function runOne(c: EvalCase, opts: EvalOptions): Promise<CaseOutcome> {
  const log = opts.log ?? (() => {});
  log(`[${c.id}] preparing`);
  const workDir = await prepareCase(opts.packDir, c, opts.workRoot, opts.reuse);
  const outcome: CaseOutcome = { id: c.id, runner: { error: "case has no inputs, so it can only be scored at agent level" }, runnerMs: 0, steps: 0 };

  if (c.inputs) {
    log(`[${c.id}] running ${c.inputs.playbook} on ${c.inputs.metric} ${c.inputs.period}`);
    const started = Date.now();
    const def = loadPackForRun(workDir);
    const toolbox = await ToolboxProcess.start({ cwd: workDir, configDir: "toolbox", binary: opts.toolbox });
    try {
      const result = await runPlaybook({
        playbook: loadPlaybook(c.inputs.playbook, workDir, opts.corePlaybooksDir),
        ontology: def.ontology,
        meta: def.meta,
        tools: new SdkToolCaller(toolbox.url),
        inputs: { metric: c.inputs.metric, period: c.inputs.period, ...(c.inputs.baseline ? { baseline: c.inputs.baseline } : {}), ...(c.inputs.more ?? {}) },
      });
      outcome.runner = scoreRunner(result, c.expect);
      outcome.steps = result.steps.length;
    } catch (e) {
      outcome.runner = { error: (e as Error).message };
    } finally {
      outcome.runnerMs = Date.now() - started;
      await toolbox.stop();
    }
  }

  if (opts.agent) {
    log(`[${c.id}] asking the agent: ${c.question}`);
    // a bundled causeline-mcp cannot search the repo for Toolbox, so hand it the binary we already found
    const run = await runClaudeCode({ question: c.question, packDir: workDir, toolbox: findToolboxBinary(opts.toolbox), ...opts.agent });
    outcome.agent = run.error
      ? { error: run.error }
      : {
          ...scoreAgent({ narrative: run.narrative, toolCalls: run.toolCalls, result: run.result, question: c.question, expectedPlaybook: c.inputs?.playbook ?? "metric_change" }, c.expect),
          metrics: run.metrics,
          narrative: run.narrative,
        };
  }
  return outcome;
}

/** Run every case in a pack (or those named), one after another. */
export async function runEvals(opts: EvalOptions): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  for (const c of loadCases(opts.packDir, opts.only)) outcomes.push(await runOne(c, opts));
  return outcomes;
}

export const defaultWorkRoot = () => join("runs", "eval-work");
