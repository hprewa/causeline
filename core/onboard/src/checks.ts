import type { DataDefs, Ontology } from "@causeline/schema";
import { toBuckets, type ToolCaller, type ToolIndex } from "@causeline/runner";

export type CheckStatus = "pass" | "warn" | "fail";

/** One deterministic data check: what was looked at, the verdict, and the numbers behind it. */
export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
  data?: Record<string, unknown>;
}

const STEP = "onboarding";
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const dayNumber = (s: string) => Math.round(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) / 86_400_000);
const dayLabel = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

export interface CheckOptions {
  ontology: Ontology;
  data: DataDefs;
  tools: ToolCaller;
  /** Finds the check tools by what they check. */
  index: ToolIndex;
  /** Periods needed in the baseline (the playbook's default is 4). */
  baseline?: number;
}

/** Everything that can be decided from the data without an opinion: shape, completeness, ranges, thickness. */
export async function runDataChecks(opts: CheckOptions): Promise<Check[]> {
  const { ontology: ont, data, tools, index } = opts;
  const baseline = opts.baseline ?? 4;
  const checks: Check[] = [];
  const metrics = Object.entries(ont.metrics).filter(([, m]) => m.type !== "product");
  // the facts the metrics are counted over; with more than one, check ids say which
  const facts = [...new Set(metrics.map(([name]) => data.metrics[name]?.fact).filter((f): f is string => !!f))];
  const top = ont.time.levels[0];

  for (const fact of facts) {
    const tag = facts.length > 1 ? `[${fact}] ` : "";
    const id = (base: string) => (facts.length > 1 ? `${base}@${fact}` : base);
    const timeColumn = data.facts[fact].time;
    const firstMetric = metrics.find(([name]) => data.metrics[name]?.fact === fact)![0];

    // --- one parent per child -----------------------------------------------------------------------
    for (const [hier, levels] of Object.entries(ont.hierarchies)) {
      for (let i = 1; i < levels.length; i++) {
        const row = (await tools.call(index.check("parent", { fact, arg: levels[i] }), {}, STEP))[0] ?? {};
        const bad = num(row.violations);
        checks.push({
          id: id(`single_parent:${levels[i]}`),
          status: bad > 0 ? "fail" : "pass",
          detail:
            bad > 0
              ? `${tag}${bad} ${levels[i]} value(s) sit under more than one ${levels[i - 1]} in hierarchy ${hier} (for example ${row.examples}); a child needs a single parent or drills are ambiguous`
              : `${tag}every ${levels[i]} has a single ${levels[i - 1]}`,
          data: { hierarchy: hier, violations: bad },
        });
      }
    }

    // --- nulls in the columns the data definition uses -----------------------------------------------
    const nulls = (await tools.call(index.check("nulls", { fact }), {}, STEP))[0] ?? {};
    const total = num(nulls.n_rows);
    const timeNulls = num(nulls[timeColumn]);
    checks.push({
      id: id("time_column_complete"),
      status: timeNulls > 0 ? "fail" : "pass",
      detail: timeNulls > 0 ? `${tag}${timeNulls} of ${total} rows have no ${timeColumn}` : `${tag}${timeColumn} is present on all ${total} rows`,
      data: { rows: total, nulls: timeNulls },
    });
    const nullCols = Object.entries(nulls)
      .filter(([k, v]) => k !== "n_rows" && k !== timeColumn && num(v) > 0)
      .map(([k, v]) => `${k}: ${num(v)}`);
    checks.push({
      id: id("columns_complete"),
      status: nullCols.length > 0 ? "warn" : "pass",
      detail: nullCols.length > 0 ? `${tag}NULLs in ${nullCols.join(", ")}; rows with a NULL in a hierarchy or dimension column fall out of every drill on it` : `${tag}no NULLs in any hierarchy, dimension or calendar column`,
      data: { nulls: Object.fromEntries(nullCols.map((c) => [c.split(":")[0], Number(c.split(":")[1])])) },
    });

    // --- time: gaps and thin days --------------------------------------------------------------------
    const days = (await tools.call(index.check("daily_rows", { fact }), {}, STEP)).map((r) => ({ day: String(r.day), n: num(r.n_rows) })).filter((d) => d.day !== "null" && d.day.length >= 10);
    if (days.length === 0) continue;
    const first = dayNumber(days[0].day);
    const last = dayNumber(days[days.length - 1].day);
    const have = new Set(days.map((d) => dayNumber(d.day)));
    const missing: string[] = [];
    for (let d = first; d <= last; d++) if (!have.has(d)) missing.push(dayLabel(d));
    const sorted = days.map((d) => d.n).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const thin = days.filter((d) => d.n < 0.25 * median).map((d) => `${d.day} (${d.n})`);
    checks.push({
      id: id("time_gaps"),
      status: missing.length > 0 ? "warn" : "pass",
      detail: missing.length > 0 ? `${tag}${missing.length} calendar day(s) between ${days[0].day} and ${days[days.length - 1].day} have no rows: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}` : `${tag}no missing days between ${days[0].day} and ${days[days.length - 1].day}`,
      data: { first: days[0].day, last: days[days.length - 1].day, missing: missing.length },
    });
    checks.push({
      id: id("thin_days"),
      status: thin.length > 0 ? "warn" : "pass",
      detail: thin.length > 0 ? `${tag}${thin.length} day(s) have under a quarter of the median ${median} rows: ${thin.slice(0, 8).join(", ")}; if this is not a closure it is missing data` : `${tag}no day has under a quarter of the median ${median} rows per day`,
      data: { median, thin: thin.length },
    });

    // --- history long enough for a baseline ----------------------------------------------------------
    const series = toBuckets(await tools.call(index.series(firstMetric, top), { start: `${days[0].day} 00:00:00`, end: `${days[days.length - 1].day} 23:59:59` }, STEP));
    const periods = series.length;
    checks.push({
      id: id("history_length"),
      status: periods < baseline + 1 ? "fail" : periods < 2 * baseline ? "warn" : "pass",
      detail:
        periods < baseline + 1
          ? `${tag}${periods} ${top} period(s) of data; a baseline of ${baseline} needs at least ${baseline + 1}`
          : periods < 2 * baseline
            ? `${tag}${periods} ${top} periods of data: enough for a baseline of ${baseline}, but a seasonal baseline wants more history`
            : `${tag}${periods} ${top} periods of data`,
      data: { periods, baseline },
    });

    // --- levels thick enough to judge ----------------------------------------------------------------
    const minVolume = Math.min(...metrics.filter(([name]) => data.metrics[name]?.fact === fact).map(([, m]) => m.min_volume));
    for (const [hier, levels] of Object.entries(ont.hierarchies)) {
      for (const level of levels) {
        const rows = (await tools.call(index.check("level", { fact, arg: level }), {}, STEP)).map((r) => ({ node: String(r.node), n: num(r.n_rows) }));
        const thinNodes = rows.filter((r) => r.n / periods < minVolume);
        const thinRows = thinNodes.reduce((a, r) => a + r.n, 0);
        const all = rows.reduce((a, r) => a + r.n, 0);
        const share = rows.length === 0 ? 0 : thinNodes.length / rows.length;
        checks.push({
          id: id(`level_volume:${level}`),
          status: share > 0.5 ? "warn" : "pass",
          detail: `${tag}${hier}/${level}: ${rows.length} node(s); ${thinNodes.length} average under ${minVolume} rows per ${top} (min_volume), holding ${all === 0 ? 0 : Math.round((thinRows / all) * 100)}% of rows${share > 0.5 ? "; most nodes are too thin to judge at this level, consider a coarser one" : ""}`,
          data: { nodes: rows.length, thin: thinNodes.length, thin_row_share: all === 0 ? 0 : thinRows / all },
        });
      }
    }
  }

  // --- value ranges, per metric ---------------------------------------------------------------------
  for (const [metric, def] of metrics) {
    const row = (await tools.call(index.check("values", { metric }), {}, STEP))[0] ?? {};
    const problems: string[] = [];
    let status: CheckStatus = "pass";
    if (num(row.num_nulls) > 0 || num(row.den_nulls) > 0) {
      status = "fail";
      problems.push(`${num(row.num_nulls) + num(row.den_nulls)} NULL numerator/denominator value(s)`);
    }
    if (def.type === "ratio" && num(row.den_min) <= 0) {
      status = "fail";
      problems.push(`the denominator reaches ${num(row.den_min)} (it must be positive)`);
    }
    if (def.type === "sum" && num(row.num_min) < 0) {
      if (status === "pass") status = "warn";
      problems.push(`negative values down to ${num(row.num_min)} in a total`);
    }
    checks.push({
      id: `values:${metric}`,
      status,
      detail: problems.length > 0 ? problems.join("; ") : `${metric}: numerator ${num(row.num_min)}..${num(row.num_max)}, denominator ${num(row.den_min)}..${num(row.den_max)}, no NULLs`,
      data: { ...row },
    });
  }
  return checks;
}
