import { BUILTIN_SLOTS, BUILTIN_TIME_LEVELS, conceptsOf, type Ontology } from "./ontology.js";
import { isRatioFormula, type DataDefs } from "./data.js";
import { findEvidence, findSeries, findSlice, type ToolsMeta } from "./meta.js";
import type { AgentDef } from "./agent.js";
import type { Playbook } from "./playbook.js";

export interface PackIssues {
  /** Problems that make the pack unusable (or its generated tools wrong). */
  errors: string[];
  /** Things worth knowing that do not block anything. */
  warnings: string[];
}

export interface PackFiles {
  ontology: Ontology;
  data: DataDefs;
  /** When given, the generated tools are checked against what the runner will ask for. */
  meta?: ToolsMeta;
  /** When given, each playbook's evidence steps are checked against the data definition. */
  playbooks?: Playbook[];
  /** When given, each expert's KPI and playbook are checked. */
  agents?: AgentDef[];
}

const builtinLevel = (name: string) => (BUILTIN_TIME_LEVELS as readonly string[]).includes(name);
const builtinSlot = (name: string) => (BUILTIN_SLOTS as readonly string[]).includes(name);

/**
 * Checks that need no data: the pack's files fit together. Each message names the file and the
 * thing to fix in plain words. The Zod schemas have already checked each field on its own; this checks
 * how ontology, data definition, generated tools and playbooks agree. Checks against the data itself
 * (single parent per child, gaps, ranges) are a separate step that needs a connection.
 */
export function validatePack(files: PackFiles): PackIssues {
  const { ontology: ont, data, meta, playbooks, agents } = files;
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- vocabulary ----------------------------------------------------------------------------------
  // every concept, time level, cycle and flag becomes part of a tool name or a query parameter
  const owners = new Map<string, string[]>();
  const claim = (name: string, owner: string) => owners.set(name, [...(owners.get(name) ?? []), owner]);
  for (const [hierarchy, levels] of Object.entries(ont.hierarchies)) for (const level of levels) claim(level, `hierarchy "${hierarchy}"`);
  for (const dim of ont.dimensions) claim(dim, "the dimensions list");
  for (const level of ont.time.levels) claim(level, "the time levels");
  const seasonality = ont.time.seasonality;
  if (seasonality !== "none") {
    for (const cycle of seasonality.cycles) claim(cycle, "the seasonality cycles");
    for (const flag of seasonality.calendar) claim(flag, "the seasonality calendar flags");
  }
  for (const [name, where] of owners) {
    if (where.length > 1) errors.push(`ontology: "${name}" is used by ${where.join(" and ")}; hierarchy levels, dimensions, time levels, cycles and flags must have different names`);
  }

  const metrics = Object.entries(ont.metrics);
  if (!metrics.some(([, m]) => m.type === "ratio" || m.type === "sum")) {
    errors.push("ontology: no ratio or sum metric: a product metric needs drivers that are ratio or sum metrics");
  }
  for (const [name, m] of metrics) {
    if (m.type === "product") {
      const seen = new Set<string>();
      for (const d of m.drivers) {
        const driver = ont.metrics[d];
        if (seen.has(d)) errors.push(`ontology: product metric "${name}" lists driver "${d}" twice`);
        seen.add(d);
        if (d === name) errors.push(`ontology: product metric "${name}" cannot be its own driver`);
        else if (!driver) errors.push(`ontology: product metric "${name}" has driver "${d}", which is not a metric in this ontology`);
        else if (driver.type === "product") errors.push(`ontology: product metric "${name}" has driver "${d}", which is itself a product; nested products are not supported`);
      }
    } else if (m.min_volume === 0) {
      warnings.push(`ontology: metric "${name}" has no min_volume: the runner will draw conclusions from very small groups`);
    }
    for (const child of m.children ?? []) if (!ont.metrics[child]) errors.push(`ontology: metric "${name}" lists "${child}" under children, which is not a metric`);
  }
  if (ont.time.levels.length < 2) warnings.push("ontology: only one time level: the runner cannot localise a change within the period");
  if (Object.keys(ont.hierarchies).length === 0 && ont.dimensions.length === 0) warnings.push("ontology: no hierarchies or dimensions: there is nothing to break a change down by");

  // --- ontology against data.yaml ------------------------------------------------------------------
  const concepts = conceptsOf(ont);
  for (const [name, m] of metrics) {
    if (m.type === "product") continue;
    const formula = data.metrics[name];
    if (!formula) {
      errors.push(`data.yaml: metric "${name}" is in the ontology but has no formula; say how it is calculated`);
      continue;
    }
    const fact = data.facts[formula.fact];
    if (!fact) {
      errors.push(`data.yaml: metric "${name}" is calculated over fact "${formula.fact}", which is not defined`);
      continue;
    }
    if (m.type === "ratio" && !isRatioFormula(formula)) errors.push(`data.yaml: metric "${name}" is a ratio in the ontology, so its formula needs a numerator and denominator`);
    if (m.type === "sum" && isRatioFormula(formula)) errors.push(`data.yaml: metric "${name}" is a sum in the ontology, so its formula needs a value`);
    for (const c of concepts) {
      if (!fact.concepts.includes(c)) errors.push(`data.yaml: fact "${formula.fact}" (used by "${name}") has no column for "${c}"; add it to its concepts or remove "${c}" from the ontology`);
    }
    for (const level of ont.time.levels) {
      if (!builtinLevel(level) && !fact.time_levels[level]) errors.push(`data.yaml: time level "${level}" is not built in, so fact "${formula.fact}" must say how to compute it under time_levels`);
    }
    if (seasonality !== "none") {
      for (const cycle of seasonality.cycles) {
        const slot = fact.slots[cycle];
        if (!builtinSlot(cycle) && (slot === undefined || typeof slot === "string")) errors.push(`data.yaml: cycle "${cycle}" is not built in, so fact "${formula.fact}" must define it under slots with expr, instance and cycle_days`);
      }
    }
  }
  for (const name of Object.keys(data.metrics)) {
    if (!ont.metrics[name]) warnings.push(`data.yaml: formula for "${name}", which is not a metric in the ontology`);
    else if (ont.metrics[name].type === "product") errors.push(`data.yaml: "${name}" is a product in the ontology; products have no formula (their drivers do)`);
  }
  for (const [name, fact] of Object.entries(data.facts)) {
    for (const c of fact.concepts) if (!concepts.includes(c)) warnings.push(`data.yaml: fact "${name}" lists concept "${c}", which the ontology does not know`);
  }
  for (const [name, ev] of Object.entries(data.evidence)) {
    for (const c of ev.about) if (!concepts.includes(c)) errors.push(`data.yaml: evidence "${name}" is about "${c}", which is not a hierarchy level or dimension in the ontology`);
  }

  // --- playbooks -----------------------------------------------------------------------------------
  for (const pb of playbooks ?? []) {
    for (const step of pb.steps) {
      if (step.evidence && step.evidence !== "*" && !data.evidence[step.evidence]) errors.push(`playbook "${pb.name}", step "${step.id}": evidence "${step.evidence}" is not defined in data.yaml`);
    }
  }

  // --- experts ---------------------------------------------------------------------------------------
  const seenAgents = new Set<string>();
  for (const a of agents ?? []) {
    if (seenAgents.has(a.name)) errors.push(`agents: two experts are called "${a.name}"`);
    seenAgents.add(a.name);
    if (!ont.metrics[a.kpi]) errors.push(`agents: expert "${a.name}" is for KPI "${a.kpi}", which is not in the ontology`);
    if (a.playbook && playbooks && !playbooks.some((p) => p.name === a.playbook)) errors.push(`agents: expert "${a.name}" uses playbook "${a.playbook}", which does not exist`);
    if (a.status === "verified" && a.examples.length === 0) warnings.push(`agents: expert "${a.name}" is marked verified but lists no example questions`);
  }

  // --- generated tools against what the runner will ask for -----------------------------------------
  if (meta) {
    for (const [name, m] of metrics) {
      if (m.type === "product") continue;
      const need = (ok: string | undefined, what: string) => {
        if (!ok) errors.push(`tools: no tool provides ${what} for "${name}"; regenerate the tools`);
      };
      for (const level of ont.time.levels) need(findSeries(meta, name, level), `the ${level} series`);
      for (const levels of Object.values(ont.hierarchies)) {
        levels.forEach((level, i) => need(findSlice(meta, name, level, i === 0 ? [] : [levels[i - 1]]), `a split by ${level}${i === 0 ? "" : ` within ${levels[i - 1]}`}`));
        for (const level of levels) for (const dim of ont.dimensions) need(findSlice(meta, name, dim, [level]), `a split by ${dim} within ${level}`);
      }
      for (const dim of ont.dimensions) need(findSlice(meta, name, dim, []), `a split by ${dim}`);
    }
    for (const name of Object.keys(data.evidence)) if (!findEvidence(meta, name)) errors.push(`tools: no tool provides evidence "${name}"; regenerate the tools`);
  }

  return { errors, warnings };
}
