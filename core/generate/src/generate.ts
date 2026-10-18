import { stringify } from "yaml";
import { conceptsOf, isRatioFormula, type DataDefs, type Ontology, type ToolMeta, type ToolsMeta } from "@causeline/schema";
import type { Dialect } from "./dialect.js";
import { factContext, type FactCtx } from "./fact.js";
import { generateEvidenceTools, generateOnboardingTools } from "./onboarding-tools.js";
import { sqlite } from "./sqlite.js";

export interface ToolParam {
  name: string;
  description: string;
  /** May be omitted by the caller; Toolbox then supplies an empty string. */
  optional?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  params: ToolParam[];
  statement: string;
  /** What the tool answers, for the sidecar index the runner looks tools up in. */
  meta: ToolMeta;
}

export interface Generated {
  tools: ToolDef[];
  /** The sidecar index of `tools` (tools.meta.yaml). */
  meta: ToolsMeta;
  skipped: { metric: string; reason: string }[];
}

const WINDOW_PARAMS: ToolParam[] = [
  { name: "cur_start", description: "Start of the current period, inclusive, as a timestamp string." },
  { name: "cur_end", description: "End of the current period, inclusive, as a timestamp string." },
  { name: "base_start", description: "Start of the baseline period, inclusive, as a timestamp string." },
  { name: "base_end", description: "End of the baseline period, inclusive, as a timestamp string." },
];

const RANGE_PARAMS: ToolParam[] = [
  { name: "start", description: "Start of the range, inclusive, as a timestamp string." },
  { name: "end", description: "End of the range, inclusive, as a timestamp string." },
];

/** Build the sidecar index from the tools' own `meta`. */
export function metaOf(tools: ToolDef[]): ToolsMeta {
  return { tools: Object.fromEntries(tools.map((t) => [t.name, t.meta])) };
}

/**
 * Generate every Toolbox tool the runner needs from the ontology (the vocabulary) and the data
 * definition (the tables and formulas). Tools return components, never rates or totals computed in
 * SQL, so the runner can decompose changes exactly:
 * - ratio: numerator and denominator, plus the sum of squared numerators (`sq`) so the runner can
 *   estimate variance for numerators that are not just 0 or 1 (a handle time, a cost per item);
 * - sum: the total (`num`), the row count (`den`) and the sum of squares (`sq`),
 *   which gives the runner the variance of a total;
 * - product: no tools of its own; its drivers are ordinary metrics.
 * Each metric's SQL reads from its fact's SELECT, so joins across tables live in data.yaml only.
 */
export function generateTools(ont: Ontology, data: DataDefs, dialect: Dialect = sqlite): Generated {
  const tools: ToolDef[] = [];
  const skipped: Generated["skipped"] = [];
  const hierarchies = Object.entries(ont.hierarchies);
  const allColumns = conceptsOf(ont);
  const persistLevel = ont.time.levels[1] ?? ont.time.levels[0];
  const facts = new Map<string, FactCtx>();
  const factOf = (name: string) => {
    if (!facts.has(name)) facts.set(name, factContext(ont, data, name, dialect));
    return facts.get(name)!;
  };

  for (const [metric, def] of Object.entries(ont.metrics)) {
    if (def.type === "product") continue; // analysed through its drivers' tools
    const formula = data.metrics[metric];
    if (!formula) {
      skipped.push({ metric, reason: "no formula in data.yaml" });
      continue;
    }
    const f = factOf(formula.fact);
    const { q, ts, from } = f;
    const ratio = isRatioFormula(formula);
    const num = ratio ? `(${formula.numerator})` : `(${formula.value})`;
    const den = ratio ? `(${formula.denominator})` : "1";
    const sq = `${num} * ${num}`;

    // Seasonality: every cycle (and calendar flag) is a slot. Series tools report each bucket's slot, and
    // node tools can restrict the BASELINE rows to the slots of a narrowed window, so a Saturday is only
    // ever compared with Saturdays. A calendar flag restricts both sides: rows the baseline cannot be
    // compared with (a holiday when it has none) are left out rather than counted against ordinary days.
    const slotParams: ToolParam[] = f.slots.map((sl) => ({
      name: `s_${sl.name}`,
      optional: true,
      description: `Comma-separated ${sl.name} slots the baseline rows must share with the current window (for example a narrowed day or time slot). Empty for no restriction.`,
    }));
    const windowParams = [...WINDOW_PARAMS, ...slotParams];
    const windowCte = `WITH p AS (SELECT ? AS cur_s, ? AS cur_e, ? AS base_s, ? AS base_e${f.slots.map((sl) => `, ? AS s_${sl.name}`).join("")})`;
    const slotFilter = (list: typeof f.slots) =>
      list.map((sl) => ` AND (p.s_${sl.name} = '' OR instr(',' || p.s_${sl.name} || ',', ',' || CAST(${sl.expr} AS TEXT) || ',') > 0)`).join("");
    const inCur = `${ts} BETWEEN p.cur_s AND p.cur_e${slotFilter(f.slots.filter((sl) => sl.calendar))}`;
    const inBase = `${ts} BETWEEN p.base_s AND p.base_e${slotFilter(f.slots)}`;
    const slotColumns = f.slots.map((sl) => `, CASE WHEN MIN(${sl.expr}) = MAX(${sl.expr}) THEN MIN(${sl.expr}) END AS slot_${sl.name}`).join("");

    const windowItems = [
      `COALESCE(SUM(CASE WHEN ${inCur} THEN ${num} END), 0) AS cur_num`,
      `COALESCE(SUM(CASE WHEN ${inCur} THEN ${den} END), 0) AS cur_den`,
      `COALESCE(SUM(CASE WHEN ${inCur} THEN ${sq} END), 0) AS cur_sq`,
      `COALESCE(SUM(CASE WHEN ${inBase} THEN ${num} END), 0) AS base_num`,
      `COALESCE(SUM(CASE WHEN ${inBase} THEN ${den} END), 0) AS base_den`,
      `COALESCE(SUM(CASE WHEN ${inBase} THEN ${sq} END), 0) AS base_sq`,
    ];
    const windowSums = windowItems.map((item, i) => `  ${item}${i < windowItems.length - 1 ? "," : ""}`);
    const windowFilter = `(${inCur} OR (${inBase}))`;
    const seriesSelect = (bucket: string) =>
      `SELECT ${bucket} AS bucket, MIN(${ts}) AS bucket_start, MAX(${ts}) AS bucket_end,\n` +
      `  COALESCE(SUM(${num}), 0) AS num, COALESCE(SUM(${den}), 0) AS den, COALESCE(SUM(${sq}), 0) AS sq${slotColumns}`;
    const slice = (by: string, filters: string[], description: string, extraParams: ToolParam[], name: string) => {
      tools.push({
        name,
        description,
        params: [...windowParams, ...extraParams],
        meta: { kind: "slice", metric, by, filters },
        statement: [
          windowCte,
          `SELECT ${q(by)} AS node,`,
          ...windowSums,
          `FROM ${from}, p`,
          `WHERE ${windowFilter}${filters.map((c) => ` AND ${q(c)} = ?`).join("")}`,
          `GROUP BY ${q(by)} ORDER BY ${q(by)};`,
        ].join("\n"),
      });
    };

    tools.push({
      name: `${metric}_extent`,
      description: `Row count and time extent of the data behind ${metric}.`,
      params: [],
      meta: { kind: "extent", metric },
      statement: `SELECT COUNT(*) AS n_rows, MIN(${ts}) AS min_ts, MAX(${ts}) AS max_ts FROM ${from};`,
    });

    // time: series of buckets over a range
    for (const level of ont.time.levels) {
      tools.push({
        name: `${metric}_by_${level}`,
        description: `${metric} numerator and denominator per ${level} bucket between start and end, with each bucket's first and last timestamp.`,
        params: RANGE_PARAMS,
        meta: { kind: "series", metric, level, filters: [] },
        statement: [seriesSelect(f.bucket(level)), `FROM ${from} WHERE ${ts} BETWEEN ? AND ?`, `GROUP BY 1 ORDER BY bucket_start;`].join("\n"),
      });
    }

    // hierarchies: children of one node (or the top level), current vs baseline
    for (const [hier, levels] of hierarchies) {
      levels.forEach((level, i) => {
        const parent = i > 0 ? levels[i - 1] : undefined;
        if (parent) {
          slice(level, [parent], `${metric} components for each ${level} within one ${parent} (hierarchy ${hier}), current period vs baseline.`, [{ name: parent, description: `The ${parent} whose ${level} children to return.` }], `${metric}_by_${level}_in_${parent}`);
          // deeper levels also get a global breakdown (no parent filter), so the runner can
          // sweep a whole level for children that cancel out inside a flat-looking parent
          slice(level, [], `${metric} components for every ${level} across the whole dataset (hierarchy ${hier}), current period vs baseline.`, [], `${metric}_by_${level}`);
        } else {
          slice(level, [], `${metric} components for each ${level} (top of hierarchy ${hier}), current period vs baseline.`, [], `${metric}_by_${level}`);
        }
      });
    }

    // flat dimensions, and inside one hierarchy node (the runner's `refine` step)
    for (const dim of ont.dimensions) {
      slice(dim, [], `${metric} components for each ${dim}, current period vs baseline.`, [], `${metric}_by_${dim}`);
    }
    for (const dim of ont.dimensions) {
      for (const level of hierarchies.flatMap(([, levels]) => levels)) {
        slice(dim, [level], `${metric} components for each ${dim} within one ${level}, current period vs baseline.`, [{ name: level, description: `The ${level} to restrict to.` }], `${metric}_by_${dim}_in_${level}`);
      }
    }

    // persistence: the next-finer time level, confined to one node
    for (const col of allColumns) {
      tools.push({
        name: `${metric}_by_${persistLevel}_for_${col}`,
        description: `${metric} per ${persistLevel} bucket between start and end, only for rows where ${col} equals one value.`,
        params: [...RANGE_PARAMS, { name: col, description: `The ${col} value to restrict to.` }],
        meta: { kind: "series", metric, level: persistLevel, filters: [col] },
        statement: [seriesSelect(f.bucket(persistLevel)), `FROM ${from} WHERE ${ts} BETWEEN ? AND ? AND ${q(col)} = ?`, `GROUP BY 1 ORDER BY bucket_start;`].join("\n"),
      });
    }
  }

  tools.push(...generateOnboardingTools(ont, data, dialect, factOf));
  tools.push(...generateEvidenceTools(data, dialect));

  const names = new Set<string>();
  for (const t of tools) {
    if (names.has(t.name)) throw new Error(`generated duplicate tool name "${t.name}"; rename a level, dimension, metric or evidence source`);
    names.add(t.name);
  }
  return { tools, meta: metaOf(tools), skipped };
}

/** Render tools as Toolbox multi-document YAML (the source is referenced by name, not written). */
export function renderYaml(tools: ToolDef[], sourceName: string, dialect: Dialect = sqlite, toolsetName = "causeline"): string {
  const docs = tools.map((t) =>
    stringify(
      {
        kind: "tool",
        name: t.name,
        type: dialect.toolType,
        source: sourceName,
        description: t.description,
        parameters: t.params.map((p) => ({ name: p.name, type: "string", description: p.description, ...(p.optional ? { required: false, default: "" } : {}) })),
        statement: t.statement + "\n",
      },
      { lineWidth: 0 },
    ),
  );
  docs.push(stringify({ kind: "toolset", name: toolsetName, tools: tools.map((t) => t.name) }, { lineWidth: 0 }));
  return (
    "# GENERATED by `causeline generate` from ontology.yaml and data.yaml -- do not edit; rerun the generator.\n" +
    "# Tools return components (numerator/denominator), never rates.\n" +
    "# Parent-scoped tools filter on the parent column alone, so node values should be unique per level.\n" +
    docs.join("---\n")
  );
}

/** Render the sidecar index (tools.meta.yaml). It lives outside Toolbox's config folder, which rejects unknown fields. */
export function renderMeta(meta: ToolsMeta): string {
  return "# GENERATED by `causeline generate` -- do not edit. What each tool answers, so the runner finds tools by meaning, not by name.\n" + stringify(meta, { lineWidth: 0 });
}
