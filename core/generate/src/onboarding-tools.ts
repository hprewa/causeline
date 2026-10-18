import { BUILTIN_SLOTS, isRatioFormula, type DataDefs, type Ontology } from "@causeline/schema";
import type { Dialect } from "./dialect.js";
import type { FactCtx } from "./fact.js";
import type { ToolDef, ToolParam } from "./generate.js";

const RANGE: ToolParam[] = [
  { name: "start", description: "Start of the range, inclusive, as a timestamp string." },
  { name: "end", description: "End of the range, inclusive, as a timestamp string." },
];

export interface Candidate {
  name: string;
  kind: "cycle" | "calendar";
}

/**
 * The cycles onboarding tests for a fact: every built-in, any custom cycle the fact defines, and each
 * calendar flag (declared in the ontology, or defined as a flag in the fact's slots).
 */
export function candidateCycles(ont: Ontology, data: DataDefs, fact: string): Candidate[] {
  const f = data.facts[fact];
  const out: Candidate[] = BUILTIN_SLOTS.map((name) => ({ name, kind: "cycle" as const }));
  for (const [name, v] of Object.entries(f?.slots ?? {})) {
    if (typeof v === "object" && !out.some((o) => o.name === name)) out.push({ name, kind: "cycle" });
  }
  const flags = new Set<string>([...(ont.time.seasonality === "none" ? [] : ont.time.seasonality.calendar), ...Object.entries(f?.slots ?? {}).filter(([, v]) => typeof v === "string").map(([k]) => k)]);
  for (const name of flags) if (!out.some((o) => o.name === name)) out.push({ name, kind: "calendar" });
  return out;
}

/**
 * Tools for onboarding. They answer two questions about the data itself, with no baseline involved:
 * - `<metric>_seasonal_<cycle>`: the metric's components by position in a cycle (and the number of
 *   occurrences behind each position), so the analyser can test whether the cycle matters;
 * - `<fact>_check_*` and `check_values_<metric>`: structural checks (one parent per child, gaps in time,
 *   nulls, value ranges, thin nodes).
 */
export function generateOnboardingTools(ont: Ontology, data: DataDefs, dialect: Dialect, factOf: (name: string) => FactCtx): ToolDef[] {
  const tools: ToolDef[] = [];
  const usedFacts = new Set<string>();

  for (const [metric, def] of Object.entries(ont.metrics)) {
    if (def.type === "product") continue;
    const formula = data.metrics[metric];
    if (!formula) continue;
    usedFacts.add(formula.fact);
    const f = factOf(formula.fact);
    const { q, ts, from } = f;
    const ratio = isRatioFormula(formula);
    const num = ratio ? `(${formula.numerator})` : `(${formula.value})`;
    const den = ratio ? `(${formula.denominator})` : "1";
    const day = dialect.slotSql({ builtin: "weekday" }, f.fact.time).instance;

    for (const cand of candidateCycles(ont, data, formula.fact)) {
      const slot = cand.kind === "calendar" ? { slot: typeof f.fact.slots[cand.name] === "string" ? (f.fact.slots[cand.name] as string) : q(cand.name), instance: day } : f.candidate(cand.name)!;
      const where = `FROM ${from} WHERE ${ts} BETWEEN ? AND ?`;
      const statement = ratio
        ? [
            `SELECT CAST(${slot.slot} AS TEXT) AS slot, COUNT(DISTINCT ${slot.instance}) AS instances,`,
            `  COALESCE(SUM(${num}), 0) AS num, COALESCE(SUM(${den}), 0) AS den, COALESCE(SUM(${num} * ${num}), 0) AS sq`,
            where,
            `GROUP BY 1 ORDER BY 1;`,
          ].join("\n")
        : [
            // a total's variance is across occurrences (days, hours), not across rows, so total per occurrence first
            `SELECT slot, COUNT(*) AS instances, COALESCE(SUM(t), 0) AS num, COALESCE(SUM(n_rows), 0) AS den, COALESCE(SUM(t * t), 0) AS sq`,
            `FROM (SELECT CAST(${slot.slot} AS TEXT) AS slot, ${slot.instance} AS inst, SUM(${num}) AS t, COUNT(*) AS n_rows`,
            `      ${where} GROUP BY 1, 2)`,
            `GROUP BY slot ORDER BY slot;`,
          ].join("\n");
      tools.push({
        name: `${metric}_seasonal_${cand.name}`,
        description: `${metric} components by position in the ${cand.name} ${cand.kind === "calendar" ? "calendar flag" : "cycle"} between start and end, with the number of occurrences of each position, to test whether it is seasonal.`,
        params: RANGE,
        meta: { kind: "seasonal_profile", metric, cycle: cand.name },
        statement,
      });
    }

    tools.push({
      name: `check_values_${metric}`,
      description: `${metric}: NULLs, minimum and maximum of its numerator and denominator over the whole fact.`,
      params: [],
      meta: { kind: "check", check: "values", metric },
      statement: [
        `SELECT COUNT(*) AS n_rows, COALESCE(SUM(${num} IS NULL), 0) AS num_nulls, MIN(${num}) AS num_min, MAX(${num}) AS num_max,`,
        `  COALESCE(SUM(${den} IS NULL), 0) AS den_nulls, MIN(${den}) AS den_min, MAX(${den}) AS den_max`,
        `FROM ${from};`,
      ].join("\n"),
    });
  }

  // --- structural checks, once per fact ---------------------------------------------------------------
  for (const name of usedFacts) {
    const f = factOf(name);
    const { q, ts, from } = f;
    const day = dialect.slotSql({ builtin: "weekday" }, f.fact.time).instance;
    for (const [hier, levels] of Object.entries(ont.hierarchies)) {
      for (let i = 1; i < levels.length; i++) {
        const child = q(levels[i]);
        const parent = q(levels[i - 1]);
        tools.push({
          name: `${name}_check_parent_${levels[i]}`,
          description: `Hierarchy ${hier}: how many ${levels[i]} values sit under more than one ${levels[i - 1]} (a child must have a single parent), with examples.`,
          params: [],
          meta: { kind: "check", check: "parent", fact: name, arg: levels[i] },
          statement: [
            `SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM ${from} GROUP BY ${child} HAVING COUNT(DISTINCT ${parent}) > 1)) AS violations,`,
            `  (SELECT group_concat(c, ', ') FROM (SELECT ${child} AS c FROM ${from} GROUP BY ${child} HAVING COUNT(DISTINCT ${parent}) > 1 LIMIT 5)) AS examples;`,
          ].join("\n"),
        });
      }
      for (const level of levels) {
        tools.push({
          name: `${name}_check_level_${level}`,
          description: `Rows per ${level} (hierarchy ${hier}) over the whole fact, to find nodes too thin to judge.`,
          params: [],
          meta: { kind: "check", check: "level", fact: name, arg: level },
          statement: `SELECT ${q(level)} AS node, COUNT(*) AS n_rows FROM ${from} GROUP BY 1 ORDER BY 1;`,
        });
      }
    }
    tools.push({
      name: `${name}_check_daily_rows`,
      description: "Rows per calendar day across the fact, to find gaps and days with far fewer rows than usual.",
      params: [],
      meta: { kind: "check", check: "daily_rows", fact: name },
      statement: `SELECT ${day} AS day, COUNT(*) AS n_rows FROM ${from} GROUP BY 1 ORDER BY 1;`,
    });
    const flags = f.slots.filter((s) => s.calendar && typeof f.fact.slots[s.name] !== "string").map((s) => s.name);
    const columns = [...new Set([f.fact.time, ...f.fact.concepts, ...flags])];
    tools.push({
      name: `${name}_check_nulls`,
      description: "Row count and the number of NULLs in every column the ontology uses (time, concepts, calendar flags).",
      params: [],
      meta: { kind: "check", check: "nulls", fact: name },
      statement: `SELECT COUNT(*) AS n_rows${columns.map((c) => `, COALESCE(SUM(${q(c)} IS NULL), 0) AS ${q(c)}`).join("")} FROM ${from};`,
    });
    void ts;
  }
  return tools;
}

/**
 * One tool per evidence source: its records in a window, optionally filtered by the concepts it is
 * about (an empty value means no filter). Capped, because evidence supports a finding and is not a data dump.
 */
export function generateEvidenceTools(data: DataDefs, dialect: Dialect): ToolDef[] {
  const q = (id: string) => dialect.quote(id);
  return Object.entries(data.evidence).map(([name, ev]) => ({
    name,
    description: ev.description ?? `Records from ${name} in a window, about the given ${ev.about.join(", ")}.`,
    params: [
      ...RANGE,
      ...ev.about.map((c) => ({ name: c, optional: true, description: `Only records about this ${c}. Empty for any.` })),
    ],
    meta: { kind: "evidence" as const, evidence: name, about: ev.about },
    statement: [
      `WITH p AS (SELECT ? AS w_start, ? AS w_end${ev.about.map((c) => `, ? AS ${q(c)}`).join("")})`,
      `SELECT e.* FROM (${ev.sql.trim()}) AS e, p`,
      ev.until
        ? `WHERE e.${q(ev.time)} <= p.w_end AND COALESCE(e.${q(ev.until)}, e.${q(ev.time)}) >= p.w_start${ev.about.map((c) => ` AND (p.${q(c)} = '' OR e.${q(c)} = p.${q(c)})`).join("")}`
        : `WHERE e.${q(ev.time)} BETWEEN p.w_start AND p.w_end${ev.about.map((c) => ` AND (p.${q(c)} = '' OR e.${q(c)} = p.${q(c)})`).join("")}`,
      `ORDER BY e.${q(ev.time)} LIMIT 200;`,
    ].join("\n"),
  }));
}
