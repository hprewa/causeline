import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { onboard, renderReport } from "./report.js";

const USAGE = `usage: causeline seasonality --pack <dir> [options]
  --backtest         replay the data's recent periods with and without the recommended seasonality (slow)
  --metrics a,b      limit the analysis to these metrics
  --baseline <n>     baseline length for the history check and backtest (default 4)
  --url <url>        use a Toolbox that is already running (default: start one on the pack)
  --json <file>      also write the full report as JSON`;

/** `causeline seasonality`: data checks, the seasonality analysis and (optionally) the backtest for a pack. */
export async function runOnboardCli(argv: string[]): Promise<void> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument "${key}"\n${USAGE}`);
    if (key === "--backtest") flags.set("backtest", "true");
    else {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${key} needs a value\n${USAGE}`);
      flags.set(key.slice(2), value);
    }
  }
  const pack = flags.get("pack");
  if (!pack) throw new Error(USAGE);
  const report = await onboard({
    packDir: resolve(pack),
    url: flags.get("url"),
    backtest: flags.has("backtest"),
    metrics: flags.get("metrics")?.split(","),
    baseline: flags.has("baseline") ? Number(flags.get("baseline")) : undefined,
  });
  console.log(renderReport(report));
  if (flags.has("json")) writeFileSync(resolve(flags.get("json")!), JSON.stringify(report, null, 2), "utf-8");
}
