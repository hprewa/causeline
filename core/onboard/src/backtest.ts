import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTools, renderYaml } from "@causeline/generate";
import { loadPlaybook, runPlaybook, SdkToolCaller, ToolboxProcess, ToolIndex, toBuckets, type ToolCaller } from "@causeline/runner";
import type { DataDefs, Ontology } from "@causeline/schema";
import type { SeasonalityAnalysis } from "./seasonality.js";

type Recommended = SeasonalityAnalysis["recommended"];

/** The ontology with a different `time.seasonality`. */
export function withSeasonality(ont: Ontology, rec: Recommended | "none"): Ontology {
  const seasonality = rec === "none" || rec.none ? ("none" as const) : { cycles: rec.cycles, calendar: rec.calendar };
  return { ...ont, time: { ...ont.time, seasonality } } as Ontology;
}

/** The YAML block to put under `time:` in ontology.yaml. */
export function renderSeasonalityBlock(rec: Recommended): string {
  if (rec.none) return "  seasonality: none";
  const lines = ["  seasonality:"];
  lines.push(`    cycles: [${rec.cycles.join(", ")}]`);
  lines.push(`    calendar: [${rec.calendar.join(", ")}]`);
  return lines.join("\n");
}

export interface MetricBacktest {
  metric: string;
  periods: number;
  /** Periods that reported a finding, a masking flag, or stopped, with the pooled (naive) baseline. */
  flaggedNaive: string[];
  /** The same, with the recommended seasonality. */
  flaggedSeasonal: string[];
}

export interface SmokeTest {
  metric: string;
  period: string;
  status: "pass" | "fail";
  detail: string;
}

export interface BacktestResult {
  metrics: MetricBacktest[];
  smoke: SmokeTest | null;
}

export interface BacktestOptions {
  packDir: string;
  ontology: Ontology;
  data: DataDefs;
  recommended: Recommended;
  baseline?: number;
  metrics?: string[];
  /** Only the most recent periods (default 8) so the run stays short. */
  lastPeriods?: number;
  binary?: string;
}

function flagged(r: { status: string; findings: unknown[]; masking_flags: { type: string }[] }): boolean {
  // a thin-cell caution is not an accusation; everything else is
  return r.status === "stopped" || r.findings.length > 0 || r.masking_flags.some((f) => f.type !== "small_cells");
}

/**
 * How would the runner have treated the data's own history, with and without the recommended
 * seasonality? Tools are generated from the candidate ontology into a scratch config folder and served
 * by a Toolbox of their own, so this works before the pack's ontology has been changed. A period that is
 * flagged both ways may be real; a period flagged only without seasonality is the pattern being misread.
 */
export async function backtest(opts: BacktestOptions): Promise<BacktestResult> {
  const candidate = withSeasonality(opts.ontology, opts.recommended);
  const naive = withSeasonality(opts.ontology, "none");
  const scratch = mkdtempSync(join(tmpdir(), "causeline-backtest-"));
  let server: ToolboxProcess | undefined;
  try {
    copyFileSync(join(opts.packDir, "toolbox", "source.yaml"), join(scratch, "source.yaml"));
    const generated = generateTools(candidate, opts.data);
    writeFileSync(join(scratch, "tools.generated.yaml"), renderYaml(generated.tools, opts.data.source), "utf-8");
    const index = new ToolIndex(generated.meta);
    server = await ToolboxProcess.start({ cwd: opts.packDir, configDir: scratch, binary: opts.binary });
    const tools: ToolCaller = new SdkToolCaller(server.url);
    const playbook = loadPlaybook("metric_change", opts.packDir);
    const baseline = opts.baseline ?? 4;
    const top = candidate.time.levels[0];
    const out: MetricBacktest[] = [];
    let smoke: SmokeTest | null = null;

    for (const [metric, def] of Object.entries(candidate.metrics)) {
      if (def.type === "product" || (opts.metrics && !opts.metrics.includes(metric))) continue;
      const counts = (await tools.call(index.extent(metric), {}, "backtest"))[0];
      const series = toBuckets(await tools.call(index.series(metric, top), { start: String(counts.min_ts), end: String(counts.max_ts) }, "backtest"));
      // a final bucket with far fewer rows than the one before is a partial period; it is not judged
      const last = series[series.length - 1];
      const before = series[series.length - 2];
      const full = last && before && last.den < 0.6 * before.den ? series.slice(0, -1) : series;
      const from = Math.max(baseline, full.length - (opts.lastPeriods ?? 8));
      const row: MetricBacktest = { metric, periods: 0, flaggedNaive: [], flaggedSeasonal: [] };
      for (let i = from; i < full.length; i++) {
        const label = full[i].bucket;
        const inputs = { metric, period: label, baseline };
        const a = await runPlaybook({ playbook, ontology: naive, meta: generated.meta, tools, inputs });
        const b = await runPlaybook({ playbook, ontology: candidate, meta: generated.meta, tools, inputs });
        row.periods++;
        if (flagged(a)) row.flaggedNaive.push(label);
        if (flagged(b)) row.flaggedSeasonal.push(label);
        if (i === full.length - 1 && !smoke) {
          smoke = {
            metric,
            period: label,
            status: b.status === "complete" || b.stopped_reason === "no_comparable_baseline" ? "pass" : "fail",
            detail: b.status === "complete" ? `ran to completion with ${b.findings.length} finding(s)` : `stopped: ${b.stopped_reason}: ${b.stopped_detail}`,
          };
        }
      }
      out.push(row);
    }
    return { metrics: out, smoke };
  } finally {
    await server?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}
