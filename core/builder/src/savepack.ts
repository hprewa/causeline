import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { generateForPack } from "@causeline/generate";
import { AgentDef, DataDefs, Ontology, isRatioFormula, loadAgents, loadPack, validatePack, type PackDefinition } from "@causeline/schema";
import { dropForChange, updateState } from "./state.js";
import { testFact, testFormula } from "./testfact.js";

export interface SaveResult {
  saved: boolean;
  /** Plain-words problems; nothing is written while there are any. */
  errors: string[];
  warnings: string[];
  tools?: number;
  /** KPIs whose formula is new or changed: they drop to provisional (or draft) until their stored numbers are checked again. */
  needs_reconciling: string[];
}

const zodMessages = (label: string, issues: { path: PropertyKey[]; message: string }[]) => issues.map((i) => `${label}: ${i.path.map(String).join(".") || "(whole)"}: ${i.message}`);

/**
 * Take the agent's draft of the pack (as plain data, not files), check it as far as it can be checked without
 * the user (shape, how the parts fit together, that every SQL statement and formula actually runs on their
 * data), and only then write the files and the query tools. The agent never writes a file itself.
 */
export async function savePack(opts: { workspace: string; ontology: unknown; data: unknown; agents?: unknown[] }): Promise<SaveResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const o = Ontology.safeParse(opts.ontology);
  const d = DataDefs.safeParse(opts.data);
  const agents: AgentDef[] = [];
  if (!o.success) errors.push(...zodMessages("ontology", o.error.issues));
  if (!d.success) errors.push(...zodMessages("data", d.error.issues));
  for (const a of opts.agents ?? []) {
    const parsed = AgentDef.safeParse(a);
    if (parsed.success) agents.push(parsed.data);
    else errors.push(...zodMessages("expert", parsed.error.issues));
  }
  if (!o.success || !d.success) return { saved: false, errors, warnings, needs_reconciling: [] };

  const issues = validatePack({ ontology: o.data, data: d.data, agents });
  errors.push(...issues.errors);
  warnings.push(...issues.warnings);

  // every fact must run on the user's data and produce the columns it promises; every formula must run over it
  for (const [name, fact] of Object.entries(d.data.facts)) {
    const t = await testFact({ workspace: opts.workspace, sql: fact.sql, time: fact.time, concepts: fact.concepts });
    if (!t.ok) {
      errors.push(`fact "${name}" does not run on your data: ${t.error}`);
      continue;
    }
    for (const w of t.warnings) (w.startsWith("there is no column") ? errors : warnings).push(`fact "${name}": ${w}`);
    for (const [kpi, f] of Object.entries(d.data.metrics).filter(([, f]) => f.fact === name)) {
      const exprs = isRatioFormula(f) ? [f.numerator, f.denominator] : [f.value];
      const r = await testFormula({ workspace: opts.workspace, factSql: fact.sql, expressions: exprs });
      if (!r.ok) errors.push(`${kpi}: its formula does not run: ${r.error}`);
      else if (r.totals!.some((x) => !Number.isFinite(x))) warnings.push(`${kpi}: its formula adds up to nothing (empty or not a number) over the whole data`);
    }
  }
  // evidence sources must run too, and carry the columns they promise
  for (const [name, ev] of Object.entries(d.data.evidence)) {
    const t = await testFact({ workspace: opts.workspace, sql: ev.sql, time: ev.time, concepts: ev.about });
    if (!t.ok) errors.push(`evidence "${name}" does not run on your data: ${t.error}`);
    else {
      for (const w of t.warnings) (w.startsWith("there is no column") ? errors : warnings).push(`evidence "${name}": ${w}`);
      if (ev.until && t.columns.length > 0 && !t.columns.includes(ev.until)) errors.push(`evidence "${name}": there is no column called ${ev.until} in the result`);
    }
  }
  if (errors.length > 0) return { saved: false, errors, warnings, needs_reconciling: [] };

  // which KPIs changed formula since the last save (a changed formula no longer matches the number the user gave)
  let before: PackDefinition | null = null;
  try {
    before = loadPack(opts.workspace);
  } catch {
    before = null;
  }
  const changed = Object.keys(d.data.metrics).filter((k) => !before || JSON.stringify(before.data.metrics[k]) !== JSON.stringify(d.data.metrics[k]) || JSON.stringify(before.data.facts[d.data.metrics[k].fact]?.sql) !== JSON.stringify(d.data.facts[d.data.metrics[k].fact].sql));

  mkdirSync(join(opts.workspace, "agents"), { recursive: true });
  writeFileSync(join(opts.workspace, "ontology.yaml"), stringify(opts.ontology, { lineWidth: 0 }), "utf-8");
  writeFileSync(join(opts.workspace, "data.yaml"), stringify(opts.data, { lineWidth: 0 }), "utf-8");
  // an expert is only ever `verified` by verify_expert: a saved draft cannot claim it, and cannot take it away
  // from an expert whose KPI is unchanged
  const earlier = new Map(loadAgents(opts.workspace).map((a) => [a.name, a]));
  for (const a of agents) {
    const keep = earlier.get(a.name)?.status === "verified" && !changed.includes(a.kpi);
    if (earlier.get(a.name)?.status === "verified" && !keep) warnings.push(`expert "${a.name}" is a draft again because ${a.kpi} changed; check it again`);
    writeFileSync(join(opts.workspace, "agents", `${a.name}.yaml`), stringify({ ...a, status: keep ? "verified" : "draft" }, { lineWidth: 0 }), "utf-8");
  }
  // an expert not mentioned this time but built on a KPI that changed loses its verification too
  for (const [name, a] of earlier) {
    if (!agents.some((x) => x.name === name) && a.status === "verified" && changed.includes(a.kpi)) {
      writeFileSync(join(opts.workspace, "agents", `${name}.yaml`), stringify({ ...a, status: "draft" }, { lineWidth: 0 }), "utf-8");
      warnings.push(`expert "${name}" is a draft again because ${a.kpi} changed; check it again`);
    }
  }
  const gen = generateForPack(opts.workspace);

  updateState(opts.workspace, (s) => {
    for (const k of Object.keys(s.kpis)) if (!d.data.metrics[k]) delete s.kpis[k];
    for (const k of Object.keys(d.data.metrics)) if (changed.includes(k) || !s.kpis[k]) s.kpis[k] = dropForChange(s.kpis[k]);
    // once the analysis has been run, what the description says about repeating patterns is a decision
    if (s.seasonalityAnalysed) s.seasonality = o.data.time.seasonality === "none" ? "none" : "confirmed";
  });
  return { saved: true, errors: [], warnings, tools: gen.generated.tools.length, needs_reconciling: changed };
}
