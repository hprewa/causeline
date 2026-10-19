import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { intentEnv, mergeIntent, validateIntent } from "@causeline/intent";
import { findToolboxBinary, loadPackForRun, SdkToolCaller, ToolboxProcess } from "@causeline/runner";
import { IntentCases, type Intent, type IntentCase, type IntentCheck, type IntentExpectation } from "@causeline/schema";
import { runClaudeCode } from "./agent.js";
import { loadCases } from "./cases.js";
import { prepareCase } from "./prepare.js";
import type { AgentConfig } from "./run.js";

/** An intent eval is a list of conversations and what each message should leave behind: <pack>/evals/intents.yaml. */
export function loadIntentCases(packDir: string): IntentCase[] {
  const file = join(packDir, "evals", "intents.yaml");
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const parsed = IntentCases.safeParse(parse(readFileSync(file, "utf-8")));
  if (!parsed.success) throw new Error(`${file} is not valid:\n` + parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  return parsed.data;
}

export interface IntentOutcome {
  id: string;
  pass: boolean;
  /** One entry per message that missed. */
  misses: string[];
  /** The live agent's attempt at the same conversation, when asked for. Scored on where the intent ended up. */
  agent?: { pass: boolean; misses: string[]; costUsd: number; turns: number; narrative?: string; error?: string; skipped?: string };
}

/** What a check said against what was expected. An expectation left out is not checked. */
export function scoreIntent(check: IntentCheck, e: IntentExpectation): string[] {
  const misses: string[] = [];
  const want = (what: string, expected: unknown, got: unknown) => {
    if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(got)) misses.push(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got ?? null)}`);
  };
  want("status", e.status, check.status);
  if (check.status === "ask") {
    want("slot", e.slot, check.slot);
    for (const o of e.offers ?? []) if (!check.options.some((x) => x.value === o)) misses.push(`the question does not offer "${o}" (offers ${check.options.map((x) => x.value).join(", ") || "nothing"})`);
    for (const w of e.says ?? []) if (!check.question.toLowerCase().includes(w.toLowerCase())) misses.push(`the question does not say "${w}": ${check.question}`);
    return misses;
  }
  const r = check.resolved;
  want("kpi", e.kpi, r.kpi);
  want("task", e.task, r.task);
  want("window", e.window, { start: r.window.start, end: r.window.end });
  want("against", e.against, r.against && { start: r.against.start, end: r.against.end });
  want("aggregation", e.aggregation, r.aggregation);
  if (e.filters) want("filters", e.filters, r.filters);
  for (const w of e.says ?? []) if (!check.playback.toLowerCase().includes(w.toLowerCase())) misses.push(`the play-back does not say "${w}": ${check.playback}`);
  return misses;
}

export interface IntentEvalOptions {
  packDir: string;
  workRoot: string;
  toolbox?: string;
  log?: (line: string) => void;
  /** Only these cases. */
  only?: string[];
  /** Also give each conversation to a live agent (costs money; never in CI). */
  agent?: AgentConfig;
}

/** The conversation as one briefing: a live session is a single prompt, so the user's messages arrive in order inside it. */
export function conversationPrompt(c: IntentCase): string {
  return [
    "A user is talking to you about their data. They send the messages below, one after another. Respond to each the way you would in a real conversation, using your tools as your skills say.",
    "When you ask them a question, their next message is their answer to it. Do not wait for them: handle every message in order, and end with your reply to the last one.",
    "",
    ...c.turns.map((t, i) => `User message ${i + 1}: ${t.say}`),
  ].join("\n");
}

/** Run every conversation against the pack's own clean data: merge each message's patch, check it, compare with what was expected. */
export async function runIntentEval(opts: IntentEvalOptions): Promise<IntentOutcome[]> {
  const log = opts.log ?? (() => {});
  const cases = loadIntentCases(opts.packDir).filter((c) => !opts.only || opts.only.includes(c.id));
  const all = loadCases(opts.packDir);
  const base = all.find((c) => c.expect.no_findings) ?? all[0];
  log(`[intents] preparing ${base.id}`);
  const workDir = await prepareCase(opts.packDir, base, resolve(opts.workRoot), false);
  const server = await ToolboxProcess.start({ cwd: workDir, configDir: "toolbox", binary: opts.toolbox });
  try {
    const tools = new SdkToolCaller(server.url);
    const pack = loadPackForRun(workDir);
    const outcomes: IntentOutcome[] = [];
    for (const c of cases) {
      const env = await intentEnv({ ontology: pack.ontology, data: pack.data, meta: pack.meta, tools, today: c.today });
      let intent: Intent = { filters: {} };
      const misses: string[] = [];
      for (const [i, turn] of c.turns.entries()) {
        if (turn.set) intent = mergeIntent(intent, turn.set);
        const check = await validateIntent(intent, env);
        if (turn.expect) for (const m of scoreIntent(check, turn.expect)) misses.push(`message ${i + 1} ("${turn.say}"): ${m}`);
      }
      const outcome: IntentOutcome = { id: c.id, pass: misses.length === 0, misses };
      const finalExpect = c.turns[c.turns.length - 1].expect;
      if (opts.agent && finalExpect) {
        if (c.today && env.as_of !== "data_end") outcome.agent = { pass: true, misses: [], costUsd: 0, turns: 0, skipped: "the case pins a date a live agent cannot be given" };
        else {
          log(`[${c.id}] asking the agent`);
          const run = await runClaudeCode({ question: conversationPrompt(c), packDir: workDir, toolbox: findToolboxBinary(opts.toolbox), ...opts.agent });
          // where the agent left the question: the last answer set_intent gave (running does not change it)
          const last = [...run.intents].reverse().find((i) => i.tool === "set_intent" && i.body?.check);
          const missed = run.error ? [run.error] : !last ? ["the agent never built an intent (no set_intent answer)"] : scoreIntent(last.body.check as IntentCheck, finalExpect);
          outcome.agent = { pass: missed.length === 0, misses: missed, costUsd: run.metrics.costUsd, turns: run.metrics.turns, narrative: run.narrative.slice(0, 1500), ...(run.error ? { error: run.error } : {}) };
        }
      }
      outcomes.push(outcome);
    }
    return outcomes;
  } finally {
    await server.stop();
  }
}

export function renderIntents(outcomes: IntentOutcome[]): string {
  const passed = outcomes.filter((o) => o.pass).length;
  const live = outcomes.filter((o) => o.agent && !o.agent.skipped);
  const lines = outcomes.map((o) => {
    const a = o.agent ? `   agent: ${o.agent.skipped ? `skipped (${o.agent.skipped})` : `${o.agent.pass ? "pass" : "MISS"} ($${o.agent.costUsd.toFixed(2)}, ${o.agent.turns} turns)`}` : "";
    const miss = (o.pass ? [] : o.misses).concat(o.agent && !o.agent.pass ? o.agent.misses.map((m) => `agent: ${m}`) : []);
    return `${o.pass ? "pass" : "MISS"}  ${o.id}${a}${miss.length ? "\n        " + miss.join("\n        ") : ""}`;
  });
  const tail = [`intent score: ${passed}/${outcomes.length}`];
  if (live.length) tail.push(`agent score: ${live.filter((o) => o.agent!.pass).length}/${live.length}   cost: $${live.reduce((t, o) => t + o.agent!.costUsd, 0).toFixed(2)}`);
  return [...lines, "", ...tail].join("\n");
}
