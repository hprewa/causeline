import { z } from "zod";

/** The questions a KPI expert can take on. `mix` is recognised by the router but has no template of its own yet. */
export const TASKS = ["value", "compare", "trend", "deep_rca"] as const;
export const Task = z.enum(TASKS);
export type Task = z.infer<typeof Task>;

/**
 * agents/<name>.yaml: a KPI expert is a task template bound to one KPI. Without a playbook it uses the core
 * template for the task, so a KPI needs no playbook of its own for value, compare or trend.
 */
export const AgentDef = z.object({
  name: z.string().min(1),
  kpi: z.string().min(1),
  task: Task,
  /** A playbook of the pack's own (it may cross tables); default is the core template for the task. */
  playbook: z.string().min(1).optional(),
  /** Plain questions this expert is meant for. Routing evals check them. */
  examples: z.array(z.string().min(1)).default([]),
  /** What to do when the finding sits in a child KPI: `follow_kpi_tree` is designed, not built. */
  handoff: z.enum(["none", "follow_kpi_tree"]).default("none"),
  /** `verified` once its eval cases pass; anything else is labelled unverified in every answer. */
  status: z.enum(["verified", "draft"]).default("draft"),
});
export type AgentDef = z.infer<typeof AgentDef>;

export const RouteOption = z.object({
  kpi: z.string().nullable(),
  task: Task.nullable(),
  /** The expert's name, or "explorer" when no expert covers the question. */
  expert: z.string(),
  playbook: z.string().nullable(),
  /** Inputs for the playbook that could be filled in from the question. */
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  status: z.enum(["verified", "draft", "exploratory"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
});
export type RouteOption = z.infer<typeof RouteOption>;

/** What the router decided, in a form an agent can explain and a user can redirect. */
export const Route = z.object({
  question: z.string(),
  /** `expert`: run the first option. `scan`: no KPI named, check them all and dig into those that moved. `explorer`: nothing covers it. */
  strategy: z.enum(["expert", "scan", "explorer"]),
  options: z.array(RouteOption).default([]),
  /** The one thing missing, asked as a single question; null when the first option can run. */
  needs: z.object({ input: z.string(), question: z.string(), choices: z.array(z.string()).optional() }).nullable().default(null),
  /** One plain sentence saying what will be done, so the user can redirect before it is. */
  announce: z.string(),
  /** For a scan: the period to scan. */
  scan: z.object({ period: z.string() }).optional(),
});
export type Route = z.infer<typeof Route>;

/** One routing eval row: a realistic question and where it should go. */
export const RoutingCase = z.object({
  question: z.string().min(1),
  expect: z.object({
    strategy: z.enum(["expert", "scan", "explorer"]).optional(),
    kpi: z.string().optional(),
    task: Task.optional(),
    expert: z.string().optional(),
    /** The period label the router must resolve. */
    period: z.string().optional(),
    /** The router must ask this one thing instead of guessing. */
    needs: z.string().optional(),
  }),
});
export type RoutingCase = z.infer<typeof RoutingCase>;
export const RoutingCases = z.array(RoutingCase);
