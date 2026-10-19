import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { intentEnv, mergeIntent, validateIntent } from "@causeline/intent";
import { loadPackForRun, SdkToolCaller, ToolboxProcess } from "@causeline/runner";
import { IntentCases, type Intent, type IntentCase, type IntentCheck, type IntentExpectation } from "@causeline/schema";
import { loadCases } from "./cases.js";
import { prepareCase } from "./prepare.js";

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
}

/** Run every conversation against the pack's own clean data: merge each message's patch, check it, compare with what was expected. */
export async function runIntentEval(opts: IntentEvalOptions): Promise<IntentOutcome[]> {
  const log = opts.log ?? (() => {});
  const cases = loadIntentCases(opts.packDir);
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
      outcomes.push({ id: c.id, pass: misses.length === 0, misses });
    }
    return outcomes;
  } finally {
    await server.stop();
  }
}

export function renderIntents(outcomes: IntentOutcome[]): string {
  const passed = outcomes.filter((o) => o.pass).length;
  const lines = outcomes.map((o) => `${o.pass ? "pass" : "MISS"}  ${o.id}${o.pass ? "" : "\n        " + o.misses.join("\n        ")}`);
  return [...lines, "", `intent score: ${passed}/${outcomes.length}`].join("\n");
}
