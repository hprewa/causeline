import { join } from "node:path";
import { loadPackForRun, loadPlaybook, resolveThresholds, SdkToolCaller, ToolboxProcess, ToolIndex, type ToolCaller } from "@causeline/runner";
import { backtest, renderSeasonalityBlock, type BacktestResult } from "./backtest.js";
import { runDataChecks, type Check } from "./checks.js";
import { analyseSeasonality, type CycleResult, type SeasonalityAnalysis } from "./seasonality.js";

export interface OnboardingReport {
  checks: Check[];
  seasonality: SeasonalityAnalysis;
  backtest?: BacktestResult;
  /** The block to paste under `time:` once the user has confirmed it. */
  seasonality_block: string;
}

export interface OnboardOptions {
  packDir: string;
  /** Use a Toolbox that is already running (default: start one on the pack). */
  url?: string;
  binary?: string;
  /** Replay the data's history with and without the recommended seasonality (slow: a Toolbox of its own, two runs per period). */
  backtest?: boolean;
  metrics?: string[];
  baseline?: number;
}

/**
 * The deterministic onboarding pass over a pack: data checks, then the seasonality analysis, then
 * (when asked) the backtest. Nothing here decides for the user: it proposes a block and shows the
 * evidence; the user confirms and edits ontology.yaml.
 */
export async function onboard(opts: OnboardOptions): Promise<OnboardingReport> {
  const { ontology, data, meta } = loadPackForRun(opts.packDir);
  const index = new ToolIndex(meta);
  const th = resolveThresholds(ontology.thresholds);
  let server: ToolboxProcess | undefined;
  try {
    let tools: ToolCaller;
    if (opts.url) tools = new SdkToolCaller(opts.url);
    else {
      server = await ToolboxProcess.start({ cwd: opts.packDir, configDir: join("toolbox"), binary: opts.binary });
      tools = new SdkToolCaller(server.url);
    }
    const first = Object.keys(data.metrics).find((m) => !opts.metrics || opts.metrics.includes(m)) ?? Object.keys(data.metrics)[0];
    const counts = (await tools.call(index.extent(first), {}, "onboarding"))[0];
    const extent = { start: String(counts.min_ts), end: String(counts.max_ts) };
    const checks = await runDataChecks({ ontology, data, tools, index, baseline: opts.baseline });
    const seasonality = await analyseSeasonality({ ontology, data, tools, index, th, extent, metrics: opts.metrics });
    const report: OnboardingReport = { checks, seasonality, seasonality_block: renderSeasonalityBlock(seasonality.recommended) };
    if (opts.backtest) {
      loadPlaybook("metric_change", opts.packDir); // fail early if the playbook cannot be found
      report.backtest = await backtest({ packDir: opts.packDir, ontology, data, recommended: seasonality.recommended, baseline: opts.baseline, metrics: opts.metrics, binary: opts.binary });
    }
    return report;
  } finally {
    await server?.stop();
  }
}

function cycleLine(r: CycleResult): string {
  const mark = r.status === "seasonal" ? "SEASONAL " : r.status === "cannot_assess" ? "CANNOT ASSESS" : "not seasonal";
  return `  ${r.metric.padEnd(16)} ${r.cycle.padEnd(18)} ${mark.padEnd(13)} ${r.reason}`;
}

/** A plain-text report for the terminal. */
export function renderReport(report: OnboardingReport): string {
  const out: string[] = [];
  out.push("DATA CHECKS");
  for (const c of report.checks) out.push(`  ${c.status.toUpperCase().padEnd(4)} ${c.id}: ${c.detail}`);
  out.push("", "SEASONALITY (each metric x each candidate cycle)");
  for (const r of report.seasonality.results) out.push(cycleLine(r));
  const rec = report.seasonality.recommended;
  out.push("", "RECOMMENDED time.seasonality (confirm before applying):", report.seasonality_block);
  const d = report.seasonality.declared;
  if (d.confirmed.length + d.unsupported.length + d.missing.length > 0) {
    out.push(`  declared and confirmed: ${d.confirmed.join(", ") || "none"}; declared but not detected: ${d.unsupported.join(", ") || "none"}; detected but not declared: ${d.missing.join(", ") || "none"}`);
  }
  for (const n of report.seasonality.notes) out.push(`  note: ${n}`);
  if (rec.none) out.push("  no cycle or calendar flag was found; `none` is recorded, not assumed");
  if (report.backtest) {
    out.push("", "BACKTEST (the data's own recent periods; a period counts if it reports a finding, a flag, or stops)");
    for (const m of report.backtest.metrics) {
      out.push(`  ${m.metric.padEnd(16)} without seasonality ${m.flaggedNaive.length} of ${m.periods} flagged; with it ${m.flaggedSeasonal.length} of ${m.periods}${m.flaggedSeasonal.length ? ` (${m.flaggedSeasonal.join(", ")})` : ""}`);
    }
    if (report.backtest.smoke) out.push(`  smoke test: ${report.backtest.smoke.status.toUpperCase()} ${report.backtest.smoke.metric} ${report.backtest.smoke.period}: ${report.backtest.smoke.detail}`);
  }
  return out.join("\n");
}
