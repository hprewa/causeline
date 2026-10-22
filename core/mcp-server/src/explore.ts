import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectSummary } from "@causeline/builder";
import { defaultGenerator, Explorer, loadPackForRun, OPS, ToolIndex, type ExploreArgs } from "@causeline/runner";
import { EXPLORATORY_SAYS, type Exploration } from "@causeline/schema";
import type { ServerConfig } from "./config.js";
import type { Callers } from "./handlers.js";

/** The arguments of the `explore` tool: the operation's own, plus what starts an exploration. */
export interface ExploreToolArgs extends Omit<ExploreArgs, "op"> {
  op: ExploreArgs["op"];
  /** The person's question in their own words (kept in the record). Give it with the first step of an exploration. */
  question?: string;
  /** Start a new exploration instead of continuing the one under way. */
  new?: boolean;
}

export const EXPLORE_OPS: readonly string[] = OPS;

/**
 * One exploration at a time per open project: a question is explored in a few steps, each a fixed read. The record is written after every
 * step, so the page shows an exploration while it is under way and nothing is lost if the conversation stops.
 */
export class ExploreService {
  private current: { explorer: Explorer; file: string } | undefined;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly callers: Callers,
  ) {}

  /** The open project changed: an exploration belongs to the data it read. */
  reset(): void {
    this.current = undefined;
  }

  private async start(question: string): Promise<{ explorer: Explorer; file: string }> {
    if (this.cfg.packDir === "") throw new Error("no project is open. Call create_project, or list_projects and open_project.");
    const pack = loadPackForRun(this.cfg.packDir);
    const rungs = new Map(projectSummary(this.cfg.packDir).kpis.map((k) => [k.kpi, k.level as string]));
    const explorer = new Explorer({
      ontology: pack.ontology,
      index: new ToolIndex(pack.meta),
      tools: await this.callers.caller(),
      question,
      rungOf: (kpi) => rungs.get(kpi) ?? "draft",
      budget: explorerBudget(pack.ontology),
    });
    explorer.record.generator = defaultGenerator();
    const file = `exploration-${explorer.record.id}.json`;
    this.current = { explorer, file };
    return this.current;
  }

  private save(c: { explorer: Explorer; file: string }): void {
    mkdirSync(this.cfg.runsDir, { recursive: true });
    writeFileSync(join(this.cfg.runsDir, c.file), JSON.stringify(c.explorer.record, null, 2) + "\n", "utf-8");
  }

  /** Run one step. A request that cannot be done is an answer (a refusal in the step), not an error. */
  async run(args: ExploreToolArgs) {
    if (!EXPLORE_OPS.includes(args.op)) throw new Error(`"${String(args.op)}" is not an operation. The operations are: ${EXPLORE_OPS.join(", ")}.`);
    const { question, new: fresh, ...op } = args;
    const c = !this.current || fresh || this.current.explorer.record.stopped ? await this.start(question ?? "") : this.current;
    const step = await c.explorer.run(op);
    this.save(c);
    const r: Exploration = c.explorer.record;
    return {
      label: "exploratory",
      about_this_answer: EXPLORATORY_SAYS,
      exploration: r.id,
      file: c.file,
      step: step.n,
      asked: step.asked,
      says: step.says,
      columns: step.columns,
      rows: step.rows,
      rows_found: step.rows_total,
      notes: step.notes,
      ...(step.refusal ? { refused: step.refusal } : {}),
      read: { queries: step.queries, ...(step.bytes_scanned !== undefined ? { bytes_scanned: step.bytes_scanned } : {}) },
      trust: r.kpis,
      budget: { ...r.budget, left: { steps: Math.max(0, r.budget.max_steps - r.budget.steps), rows: Math.max(0, r.budget.max_rows - r.budget.rows) } },
      ...(r.stopped ? { stopped: r.stopped } : {}),
    };
  }
}

/** A pack may set its own budgets in `ontology.yaml` under `explorer`; anything unset keeps the default. */
function explorerBudget(ont: unknown): { steps?: number; rows?: number } {
  const e = (ont as { explorer?: { max_steps?: number; max_rows?: number } }).explorer;
  return { ...(e?.max_steps ? { steps: e.max_steps } : {}), ...(e?.max_rows ? { rows: e.max_rows } : {}) };
}
