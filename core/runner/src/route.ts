import { evaluate, factsRead, parseCondition, type Playbook, type Target } from "@causeline/schema";
import type { RunContext } from "./context.js";

/** The most steps one run may execute, loops included; past it the run stops with a stated reason instead of going on. */
export const STEP_BUDGET = 40;

export type Route = { to: number } | { stop: { reason: string; detail: string } } | { handoff: string };

const showFact = (v: unknown) => (v === undefined || v === null ? "nothing" : String(v));
const reads = (ctx: RunContext, cond: string) => factsRead(parseCondition(cond)).map((f) => `${f} = ${showFact(ctx.facts[f])}`).join(", ");

/** Should this step run? A step without `when` always does. */
export function shouldRun(ctx: RunContext, step: Playbook["steps"][number]): boolean {
  return !step.when || !!evaluate(parseCondition(step.when), ctx.facts);
}

/** Note on the trace that a step was skipped, and why. */
export function traceSkipped(ctx: RunContext, step: Playbook["steps"][number], compute: string): void {
  ctx.trace.push({ step: step.id, compute, facts: {}, rule: `skipped: when ${step.when}`, because: reads(ctx, step.when!), skipped: [] });
}

function resolve(target: Target, index: Map<string, number>): Route {
  if (typeof target === "string") return { to: index.get(target)! };
  if ("stop" in target) return { stop: { reason: target.stop, detail: `the playbook ends the run here (${target.stop})` } };
  return { handoff: target.handoff };
}

/**
 * Where the run goes after step `i` (whose entry is the last in the trace): the first rule of its `next` whose condition holds, else the
 * following step, else the end (`to` past the last step). The rule that fired, the facts it read and the rules that did not fire are
 * written onto the step's trace entry.
 */
export function routeAfter(ctx: RunContext, playbook: Playbook, i: number): Route {
  const step = playbook.steps[i];
  const index = new Map(playbook.steps.map((s, k) => [s.id, k]));
  if (!step.next) return { to: i + 1 };
  const entry = ctx.trace[ctx.trace.length - 1];
  const skipped: string[] = [];
  for (const rule of step.next) {
    if (rule.else !== undefined) {
      entry.rule = `else ${JSON.stringify(rule.else)}`;
      entry.because = skipped.length > 0 ? "no earlier rule held" : "no condition";
      entry.skipped = skipped;
      return resolve(rule.else, index);
    }
    if (evaluate(parseCondition(rule.if!), ctx.facts)) {
      entry.rule = `if ${rule.if} then ${JSON.stringify(rule.then)}`;
      entry.because = reads(ctx, rule.if!);
      entry.skipped = skipped;
      return resolve(rule.then!, index);
    }
    skipped.push(`if ${rule.if} (${reads(ctx, rule.if!)})`);
  }
  return { to: i + 1 };
}
