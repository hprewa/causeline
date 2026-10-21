import { z } from "zod";
import { ConditionError, parseCondition } from "./condition.js";

export const PlaybookInput = z.object({
  type: z.enum(["string", "int", "float", "boolean"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type PlaybookInput = z.infer<typeof PlaybookInput>;

/** Where a rule sends the run: a step, the end with a reason, or another KPI's analysis. */
export const Target = z.union([z.string().min(1), z.object({ stop: z.string().min(1) }).strict(), z.object({ handoff: z.string().min(1) }).strict()]);
export type Target = z.infer<typeof Target>;

/** `if` a condition on published facts holds, go `then`; the last rule has no `if` and is the `else`. */
export const Rule = z
  .object({ if: z.string().min(1).optional(), then: Target.optional(), else: Target.optional() })
  .strict()
  .refine((r) => (r.if !== undefined && r.then !== undefined && r.else === undefined) || (r.if === undefined && r.then === undefined && r.else !== undefined), {
    message: 'a rule is either "if" with "then", or "else" on its own',
  });
export type Rule = z.infer<typeof Rule>;

export const PlaybookStep = z
  .object({
    id: z.string().min(1),
    /** Run this step only if the condition on published facts holds; otherwise skip it and go on to the following step. */
    when: z.string().min(1).optional(),
    /** After this step, the first rule whose condition holds decides what runs next. Absent: the following step. */
    next: z.array(Rule).min(1).optional(),
    /** A step that can be reached more than once says how many times it may run. */
    max_visits: z.number().int().min(1).max(10).optional(),
    /** Name of a plain-TypeScript compute function in core/runner — never an LLM call, never a domain term. */
    compute: z.string().min(1).optional(),
    /**
     * Ask an evidence source (defined in the pack's data.yaml) for records about the culprits the drill
     * found. The runner passes the concepts the source is about; the playbook names no table or column.
     */
    evidence: z.string().min(1).optional(),
    over: z.enum(["time", "hierarchies"]).optional(),
    /** Id of an earlier step whose result window this step is scoped within. */
    within: z.string().min(1).optional(),
  })
  .refine((s) => (s.compute === undefined) !== (s.evidence === undefined), { message: "a step is either a compute step or an evidence step" });
export type PlaybookStep = z.infer<typeof PlaybookStep>;

export const Playbook = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    inputs: z.record(z.string().min(1), PlaybookInput).default({}),
    steps: z.array(PlaybookStep).min(1),
    output: z.string().min(1).default("result.json"),
  })
  .superRefine((playbook, ctx) => {
    const seenIds = new Set<string>();
    const stepIds = new Set(playbook.steps.map((s) => s.id));
    if (stepIds.size !== playbook.steps.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "step ids must be unique",
        path: ["steps"],
      });
    }
    for (let i = 0; i < playbook.steps.length; i++) {
      const step = playbook.steps[i];
      if (step.within && !seenIds.has(step.within)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}" has within="${step.within}", which is not an earlier step id`,
          path: ["steps", i, "within"],
        });
      }
      seenIds.add(step.id);
    }
    const parses = (src: string, path: (string | number)[]) => {
      try {
        parseCondition(src);
      } catch (e) {
        if (!(e instanceof ConditionError)) throw e;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: e.message, path });
      }
    };
    playbook.steps.forEach((step, i) => {
      if (step.when) parses(step.when, ["steps", i, "when"]);
      (step.next ?? []).forEach((rule, j) => {
        if (rule.if) parses(rule.if, ["steps", i, "next", j, "if"]);
        const to = rule.then ?? rule.else;
        if (typeof to === "string" && !stepIds.has(to)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${step.id}" sends the run to "${to}", which is not a step`, path: ["steps", i, "next", j] });
      });
      if (step.next && step.next[step.next.length - 1].else === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${step.id}": the last rule must be an "else", so every run has somewhere to go`, path: ["steps", i, "next"] });
      }
    });
  });
export type Playbook = z.infer<typeof Playbook>;
