import { z } from "zod";

export const PlaybookInput = z.object({
  type: z.enum(["string", "int", "float", "boolean"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type PlaybookInput = z.infer<typeof PlaybookInput>;

export const PlaybookStep = z
  .object({
    id: z.string().min(1),
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
  });
export type Playbook = z.infer<typeof Playbook>;
