import { loadAgents, loadPack, isRatioFormula, type AgentDef, type DataDefs, type Ontology } from "@causeline/schema";
import { readState, updateState } from "./state.js";

const words = (s: string) => s.replace(/_/g, " ");
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const code = (expr: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) ? `"${words(expr)}"` : `\`${expr}\``);

/** The tables a SELECT reads from, by name (what it needs to be built from). */
export function tablesIn(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) names.add(m[1]);
  return [...names];
}

const CYCLE_WORDS: Record<string, string> = {
  weekday: "Each day is compared with the same day of the week in earlier weeks (a Saturday with Saturdays).",
  hour_of_day: "Each hour is compared with the same hour of the day on earlier days.",
  half_hour_of_day: "Each half hour is compared with the same half hour on earlier days.",
  day_of_month: "Each day is compared with the same day of the month in earlier months.",
  month_of_year: "Each month is compared with the same month in earlier years.",
};

/**
 * The pack as plain sentences, in a fixed order, from the files themselves: what the user confirms is what
 * the system uses. No YAML, no SQL beyond a formula quoted where there is no other way to say it.
 */
export function describePack(ontology: Ontology, data: DataDefs, agents: AgentDef[] = []): string[] {
  const out: string[] = [];
  const levels = ontology.time.levels;
  out.push(`Questions are asked about one ${levels[0]} at a time, and a change can be narrowed down to ${list(levels.slice(1))}.`);
  for (const [name, hierarchy] of Object.entries(ontology.hierarchies)) {
    out.push(hierarchy.length === 1 ? `${words(name)}: ${words(hierarchy[0])}.` : `${words(name)}, from the broadest to the finest: ${hierarchy.map(words).join(", then ")} (each ${words(hierarchy[hierarchy.length - 1])} belongs to one ${words(hierarchy[hierarchy.length - 2])}).`);
  }
  if (ontology.dimensions.length > 0) out.push(`Any KPI can also be broken down by ${list(ontology.dimensions.map(words))}.`);

  for (const [kpi, def] of Object.entries(ontology.metrics)) {
    const formula = data.metrics[kpi];
    const head = `${words(kpi)}${def.description ? ` (${def.description.replace(/\.$/, "")})` : ""}`;
    const better = def.direction === "higher_is_better" ? "higher is better" : "lower is better";
    if (def.type === "product") {
      out.push(`${head} is ${list(def.drivers.map(words))} multiplied together; ${better}. A change is explained by splitting it between those.`);
      continue;
    }
    if (!formula) {
      out.push(`${head}: no way of calculating it has been given yet.`);
      continue;
    }
    const fact = data.facts[formula.fact];
    const from = list(tablesIn(fact.sql).map(words));
    const how = isRatioFormula(formula)
      ? formula.denominator === "1"
        ? `the average of ${code(formula.numerator)}`
        : `${code(formula.numerator)} divided by ${code(formula.denominator)}`
      : `the total of ${code(formula.value)}`;
    out.push(`${head} is ${how}, taken over every "${words(formula.fact)}" record, which is built from ${from || "the data"}; ${better}. Groups smaller than ${def.min_volume || "(no minimum)"} are not used to draw conclusions.`);
    if (def.synonyms?.length) out.push(`People may also call ${words(kpi)}: ${list(def.synonyms)}.`);
  }
  for (const [name, fact] of Object.entries(data.facts)) {
    out.push(`A "${words(name)}" record carries ${list(fact.concepts.map(words))}, and happens at the time in "${words(fact.time)}".`);
  }

  const s = ontology.time.seasonality;
  if (s === "none") out.push("Nothing repeats in a way that matters, so every period is compared with the plain average of the ones before it.");
  else {
    for (const c of s.cycles) out.push(CYCLE_WORDS[c] ?? `Positions in the ${words(c)} cycle are compared with the same position earlier.`);
    for (const f of s.calendar) out.push(`Days flagged "${words(f)}" are only compared with other days flagged the same way; if there are none to compare with, I say so instead of guessing.`);
  }
  for (const [name, ev] of Object.entries(data.evidence)) {
    out.push(`When something is found, I look up ${ev.description ? ev.description.replace(/\.$/, "").toLowerCase() : words(name)} about the ${list(ev.about.map(words))} concerned. That supports the finding; it does not prove the cause.`);
  }
  for (const a of agents) {
    out.push(`Expert "${a.name}" answers ${words(a.task)} questions about ${words(a.kpi)}${a.playbook ? ` using the ${words(a.playbook)} steps` : ""}. It is ${a.status === "verified" ? "verified" : "a draft (not checked against a past case yet)"}.`);
  }
  return out;
}

export interface PlayBack {
  sentences: { n: number; text: string }[];
  /** Against what was confirmed last time: sentences that are new, and ones that are gone. */
  changes: { added: string[]; removed: string[] };
  confirmed: boolean;
}

/** The saved pack as numbered sentences for the user to read, with what changed since they last confirmed. */
export function playBack(workspace: string): PlayBack {
  const pack = loadPack(workspace);
  const texts = describePack(pack.ontology, pack.data, loadAgents(workspace));
  const confirmed = readState(workspace)?.confirmed ?? [];
  return {
    sentences: texts.map((text, i) => ({ n: i + 1, text })),
    changes: { added: texts.filter((t) => !confirmed.includes(t)), removed: confirmed.filter((t) => !texts.includes(t)) },
    confirmed: confirmed.length > 0 && texts.every((t) => confirmed.includes(t)) && confirmed.every((t) => texts.includes(t)),
  };
}

/** The user has read the sentences and agrees: remember exactly what they agreed to. */
export function confirmPlayBack(workspace: string): PlayBack {
  const pb = playBack(workspace);
  updateState(workspace, (s) => {
    s.confirmed = pb.sentences.map((x) => x.text);
  });
  return playBack(workspace);
}
