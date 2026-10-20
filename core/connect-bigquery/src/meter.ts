import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { loadPack, parseToolRef, type Cost } from "@causeline/schema";
import { RunStop, type Row, type ToolCaller } from "@causeline/runner";
import { dryRun, type BigQueryTarget } from "./dryrun.js";
import { bigQueryProject } from "./connect.js";

/** On-demand list price per tebibyte read. The first terabyte each month is free, so this is an upper estimate. */
export const USD_PER_TIB = 6.25;
export const DEFAULT_BUDGET_GB = 5;

export interface ToolStatement {
  sql: string;
  /** Every declared parameter, with the value it takes when the caller leaves it out. */
  params: Record<string, string>;
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1);

/**
 * Counts what a run reads in BigQuery. Before the first call of each tool it asks BigQuery for a dry run (free) and
 * remembers the bytes; every call after that adds the same amount, which is exact for an unpartitioned table and an
 * upper bound for a partitioned one. When the total would pass the budget it stops the run with a plain-words reason,
 * before the query that would exceed it is sent.
 */
export class MeteredToolCaller implements ToolCaller {
  private queries = 0;
  private bytes = 0;
  private readonly perTool = new Map<string, number>();

  constructor(
    private readonly inner: ToolCaller,
    private readonly statements: Map<string, ToolStatement>,
    private readonly estimate: (sql: string, params: Record<string, string>) => Promise<number>,
    private readonly budgetBytes: number | null,
  ) {}

  async call(tool: string, params: Record<string, string>, stepId: string): Promise<Row[]> {
    const { name, bound } = parseToolRef(tool);
    const st = this.statements.get(name);
    if (st) {
      let bytes = this.perTool.get(name);
      if (bytes === undefined) {
        bytes = await this.estimate(st.sql, { ...st.params, ...bound, ...params });
        this.perTool.set(name, bytes);
      }
      if (this.budgetBytes !== null && this.bytes + bytes > this.budgetBytes) {
        throw new RunStop(
          "cost_budget",
          `This question would read more than ${gb(this.budgetBytes)} GB of BigQuery data (it has read ${gb(this.bytes)} GB so far), which is the limit for one question, so I stopped before running more queries. Narrow it down (one place, one week), or raise the limit if this is expected.`,
        );
      }
      this.bytes += bytes;
    }
    this.queries++;
    return this.inner.call(tool, params, stepId);
  }

  cost(): Cost {
    return { queries: this.queries, bytes_scanned: this.bytes, estimated_usd: Math.round((this.bytes / 2 ** 40) * USD_PER_TIB * 1e6) / 1e6, budget_bytes: this.budgetBytes };
  }
}

/** Every tool's statement and parameter defaults, from the pack's generated Toolbox file. */
export function readStatements(toolsYaml: string): Map<string, ToolStatement> {
  const out = new Map<string, ToolStatement>();
  for (const doc of parseAllDocuments(toolsYaml)) {
    const d = doc.toJS() as { kind?: string; name?: string; statement?: string; parameters?: { name: string; default?: unknown }[] };
    if (d?.kind !== "tool" || !d.name || !d.statement) continue;
    out.set(d.name, { sql: d.statement, params: Object.fromEntries((d.parameters ?? []).map((p) => [p.name, p.default === undefined ? "" : String(p.default)])) });
  }
  return out;
}

/**
 * Wrap a tool caller with cost accounting when the pack runs on BigQuery; return it untouched otherwise.
 * The project comes from CAUSELINE_BQ_PROJECT (or what the workspace was connected with) and the per-question limit from
 * CAUSELINE_BQ_BUDGET_GB, else `budget_gb` in data.yaml, else the default (0 = no limit).
 */
/** The smallest row limit that can be trusted: Toolbox's own default (50) silently truncates results. */
export const MIN_RESULT_ROWS = 10000;

/** Is a BigQuery source file safe to analyse through? Returns what is wrong, in plain words, or null. */
export function sourceProblem(sourceYaml: string): string | null {
  for (const doc of parseAllDocuments(sourceYaml)) {
    const d = doc.toJS() as { kind?: string; type?: string; maxQueryResultRows?: unknown } | null;
    if (d?.kind !== "source" || d.type !== "bigquery") continue;
    const rows = Number(d.maxQueryResultRows ?? 0);
    if (!(rows >= MIN_RESULT_ROWS)) {
      return `The BigQuery source does not set maxQueryResultRows (or sets it below ${MIN_RESULT_ROWS}). Toolbox then returns only 50 rows per query and silently drops the rest, which would make the analysis wrong. Add "maxQueryResultRows: 100000" to the source.`;
    }
  }
  return null;
}

export function withCostControl(packDir: string, caller: ToolCaller, env: NodeJS.ProcessEnv = process.env): ToolCaller {
  const pack = loadPack(packDir, { skipMeta: true });
  if (pack.data.dialect !== "bigquery") return caller;
  const project = bigQueryProject(packDir, env);
  if (!project) throw new Error("This pack reads from BigQuery, but no Google Cloud project is set. Set CAUSELINE_BQ_PROJECT to its id.");
  const sourceFile = join(packDir, "toolbox", "source.yaml");
  const problem = existsSync(sourceFile) ? sourceProblem(readFileSync(sourceFile, "utf-8")) : null;
  if (problem) throw new Error(problem);
  const file = join(packDir, "toolbox", "tools.generated.yaml");
  if (!existsSync(file)) throw new Error(`${file} does not exist; generate the tools first`);
  // the environment decides first; else the pack's own figure (a big table needs more than the default); else the default
  const budget = Number(env.CAUSELINE_BQ_BUDGET_GB ?? pack.data.budget_gb ?? DEFAULT_BUDGET_GB);
  const target: BigQueryTarget = { project };
  return new MeteredToolCaller(caller, readStatements(readFileSync(file, "utf-8")), async (sql, params) => (await dryRun(target, sql, params)).bytes, budget > 0 ? budget * 1e9 : null);
}
