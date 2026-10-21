import { factsRead, parseCondition, type Playbook } from "@causeline/schema";
import { FACTS } from "./facts.js";

const computeOf = (s: Playbook["steps"][number]) => (s.evidence ? "evidence" : s.compute!);

/**
 * Problems with a playbook that the schema cannot see: a condition that reads a fact no earlier step publishes, a rule that sends the run
 * back to a step that does not say how often it may run, and steps no rule can reach. An empty list means the playbook is sound.
 */
export function checkPlaybook(playbook: Playbook): string[] {
  const problems: string[] = [];
  const index = new Map(playbook.steps.map((s, i) => [s.id, i]));

  const checkFacts = (cond: string, readerIndex: number, where: string, includeSelf: boolean) => {
    for (const fact of factsRead(parseCondition(cond))) {
      const [stepId, name] = fact.split(".");
      const at = index.get(stepId);
      if (at === undefined) problems.push(`${where} reads "${fact}", but there is no step "${stepId}"`);
      else if (at > readerIndex || (at === readerIndex && !includeSelf)) problems.push(`${where} reads "${fact}", which a later step publishes`);
      else if (!(FACTS[computeOf(playbook.steps[at])] ?? []).includes(name)) problems.push(`${where} reads "${fact}", but step "${stepId}" (${computeOf(playbook.steps[at])}) publishes only: ${(FACTS[computeOf(playbook.steps[at])] ?? []).join(", ") || "nothing"}`);
    }
  };

  const reachable = new Set<number>([0]);
  const todo = [0];
  const visit = (to: number) => {
    if (!reachable.has(to)) {
      reachable.add(to);
      todo.push(to);
    }
  };
  playbook.steps.forEach((step, i) => {
    if (step.when) checkFacts(step.when, i, `step "${step.id}" (when)`, false);
    for (const rule of step.next ?? []) {
      if (rule.if) checkFacts(rule.if, i, `step "${step.id}" (next)`, true);
      const to = rule.then ?? rule.else;
      if (typeof to === "string") {
        const target = index.get(to)!;
        if (target <= i && playbook.steps[target].max_visits === undefined) problems.push(`step "${step.id}" sends the run back to "${to}", which does not say how many times it may run (max_visits)`);
      }
    }
  });
  while (todo.length > 0) {
    const i = todo.shift()!;
    const step = playbook.steps[i];
    // the following step is where a step without rules goes, and where a step that is skipped (its `when` does not hold) goes
    if (i + 1 < playbook.steps.length && (!step.next || step.when)) visit(i + 1);
    for (const rule of step.next ?? []) {
      const to = rule.then ?? rule.else;
      if (typeof to === "string") visit(index.get(to)!);
    }
  }
  playbook.steps.forEach((s, i) => {
    if (!reachable.has(i)) problems.push(`step "${s.id}" can never run`);
  });
  return problems;
}
