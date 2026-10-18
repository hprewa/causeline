import { Result, type Driver, type Generator, type Ontology, type PathNode, type Playbook } from "@causeline/schema";
import type { ResolvedThresholds } from "./masking.js";
import { seasonalExpectation } from "./expectation.js";
import { resolvePeriod } from "./period.js";
import { slotNamesOf } from "./seasonal.js";
import { toBuckets } from "./rows.js";
import { rate, zScore, zSum } from "./stats.js";
import { LoggingToolCaller } from "./toolcaller.js";
import type { ToolIndex } from "./toolindex.js";
import type { ToolCaller } from "./types.js";

type Inputs = Record<string, string | number | boolean>;
type ProductDef = Extract<Ontology["metrics"][string], { type: "product" }>;

export interface ProductArgs {
  playbook: Playbook;
  ontology: Ontology;
  tools: ToolCaller;
  index: ToolIndex;
  inputs: Inputs;
  metric: string;
  def: ProductDef;
  th: ResolvedThresholds;
  generator: Generator;
  /** Runs the playbook on one metric; passed in so this module does not import the runner. */
  recurse: (inputs: Inputs) => Promise<Result>;
}

const STEP = "driver_split";

/**
 * A product metric (Y = d1 x d2 x ...) is analysed through its drivers, which are ordinary
 * metrics. Step 1: take each driver's value in the period and its baseline value (a ratio's
 * pooled rate; a total's average per baseline period), so the product holds in both windows.
 * Step 2: split the change of Y across the drivers with the log method, share_i = ln(d1/d0) /
 * ln(Y1/Y0), which is exact and does not depend on driver order. Step 3: if one significant driver
 * explains enough of the change, run the same playbook on that driver as a metric in its own
 * right; otherwise report the split and stop, because no single driver is the story.
 */
export async function runProductMetric(a: ProductArgs): Promise<Result> {
  const { ontology, def, th } = a;
  const tools = new LoggingToolCaller(a.tools);
  const period = String(a.inputs.period);
  const baselineCount = Number(a.inputs.baseline);

  const base = { playbook: a.playbook.name, inputs: a.inputs, generator: a.generator, narrative: null };
  const stopped = (reason: string, detail: string) =>
    Result.parse({ ...base, status: "stopped", headline: null, findings: [], path: [], masking_flags: [], steps: tools.log, stopped_reason: reason, stopped_detail: detail });

  const firstDriver = def.drivers[0];
  const counts = await tools.call(a.index.extent(firstDriver), {}, STEP);
  if (Number(counts[0]?.n_rows ?? 0) === 0) return stopped("empty_data", "the entity table has no rows");
  const extent = { start: String(counts[0].min_ts), end: String(counts[0].max_ts) };
  const topLevel = ontology.time.levels[0];

  const drivers: Driver[] = [];
  let window: { start: string; end: string } | undefined;
  for (const name of def.drivers) {
    const driverDef = ontology.metrics[name];
    if (!driverDef || driverDef.type === "product") return stopped("bad_driver", `driver "${name}" is not a ratio or sum metric`);
    const series = toBuckets(await tools.call(a.index.series(name, topLevel), extent, STEP));
    const info = resolvePeriod(series, period, baselineCount, slotNamesOf(ontology).calendar);
    if ("error" in info) return stopped(info.error, `driver "${name}": ${info.detail}`);
    window ??= info.cur;

    const scale = 1 / info.baselineLabels.length;
    const isSum = driverDef.type === "sum";
    const value = isSum ? info.curComponents.num : rate(info.curComponents);
    const kind = isSum ? "sum" : "ratio";
    // the baseline is what the period should have been at its own mix of weekdays/hours/flags, when seasonality is declared
    const expectation = await seasonalExpectation(tools, a.index, ontology, name, kind, info, STEP);
    if (expectation === "none_comparable") return stopped("no_comparable_baseline", `driver "${name}": no day of the period has a comparable day in the baseline`);
    const baseline = expectation ? expectation.expected : isSum ? info.baseComponents.num * scale : rate(info.baseComponents);
    if (value === null || baseline === null || !(value > 0) || !(baseline > 0)) {
      return stopped("product_driver_nonpositive", `driver "${name}" is ${value ?? "empty"} now and ${baseline ?? "empty"} in the baseline; the log split needs positive values`);
    }
    const z = expectation ? expectation.z : isSum ? zSum(info.curComponents, info.baseComponents, scale) : zScore(info.curComponents, info.baseComponents);
    drivers.push({ metric: name, value, baseline, change: value - baseline, share: null, significant: Math.abs(z) >= th.parent_z });
  }

  const now = drivers.reduce((p, d) => p * d.value, 1);
  const before = drivers.reduce((p, d) => p * d.baseline, 1);
  const logChange = Math.log(now / before);
  for (const d of drivers) d.share = logChange === 0 ? null : Math.log(d.value / d.baseline) / logChange;
  const headline = { metric: a.metric, kind: "product" as const, format: "number" as const, value: now, baseline: before, change: now - before, relative_change: (now - before) / before };

  // the driver carrying the change: significant, moving the same way as the product, and big enough
  const dominant = drivers
    .filter((d) => d.significant && d.share !== null && d.share >= th.drill_share)
    .sort((x, y) => (y.share ?? 0) - (x.share ?? 0))[0];

  const split: PathNode = {
    level: "driver",
    node: dominant?.metric ?? "(none)",
    decision: dominant ? "drill" : "broad",
    hierarchy: "metric",
    numbers: {
      product_value: now,
      product_baseline: before,
      change: now - before,
      drivers: Object.fromEntries(drivers.map((d) => [d.metric, { share: d.share, change: d.change, significant: d.significant }])),
      reason: dominant
        ? `${dominant.metric} carries ${((dominant.share ?? 0) * 100).toFixed(0)}% of the change`
        : drivers.some((d) => d.significant)
          ? "no single driver carries most of the change: it is spread across the drivers"
          : "no driver changed significantly",
    },
  };

  if (!dominant) {
    return Result.parse({
      ...base,
      status: "complete",
      ...(window ? { window } : {}),
      onset: null,
      headline,
      drivers,
      drilled_driver: null,
      findings: [],
      path: [split],
      masking_flags: [],
      steps: tools.log,
      stopped_reason: null,
      stopped_detail: null,
    });
  }

  const inner = await a.recurse({ ...a.inputs, metric: dominant.metric });
  return Result.parse({
    ...inner,
    ...base,
    headline,
    drivers,
    drilled_driver: dominant.metric,
    path: [split, ...inner.path],
    steps: [...tools.log, ...inner.steps],
  });
}
