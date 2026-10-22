import { conceptsOf, type Ontology } from "@causeline/schema";

/**
 * Questions that name a KPI but ask for something no expert covers: a ranking ("which of them had the highest ..."), a top or bottom list,
 * or a breakdown by a concept the pack has. They go to the Explorer, which reads the data in fixed ways and labels the answer
 * exploratory. The shape is a hint for the first read, never an instruction: the assistant still chooses the operation.
 */
export interface ExploreShape {
  op: "rank" | "breakdown";
  by?: string;
  order?: "highest" | "lowest";
  top?: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[_\-]+/g, " ").replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim();
const HIGH = /\b(highest|most|biggest|largest|busiest|longest|greatest|top)\b/;
const LOW = /\b(lowest|least|smallest|shortest|fewest|quietest|bottom)\b/;
const BEST = /\b(best)\b/;
const WORST = /\b(worst)\b/;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** The concept a question names, with its plural, as the pack names it. */
function conceptIn(q: string, ont: Ontology): string | undefined {
  const found = conceptsOf(ont)
    .map((c) => ({ c, at: new RegExp(`\\b${norm(c).replace(/\./g, "\\.")}s?\\b`).exec(q)?.index ?? -1 }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at);
  return found[0]?.c;
}

export function explorationShape(question: string, ont: Ontology, kpi?: string): ExploreShape | null {
  const q = norm(question);
  if (/\bwhy\b/.test(q)) return null;
  const by = conceptIn(q, ont);

  // a ranking: an extreme word, or a top or bottom list, or "rank"
  const direction = kpi ? ont.metrics[kpi]?.direction : undefined;
  let order: ExploreShape["order"];
  if (HIGH.test(q)) order = "highest";
  else if (LOW.test(q)) order = "lowest";
  else if (WORST.test(q) && direction) order = direction === "higher_is_better" ? "lowest" : "highest";
  else if (BEST.test(q) && direction) order = direction === "higher_is_better" ? "highest" : "lowest";
  const listed = /\b(top|bottom)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(q);
  const ranked = /\brank(ed|ing|s)?\b/.test(q);
  if (order || listed || ranked) {
    const n = listed ? (NUMBER_WORDS[listed[2]] ?? Number(listed[2])) : undefined;
    if (listed?.[1] === "bottom") order = "lowest";
    if (listed?.[1] === "top") order = "highest";
    // an extreme word with no concept to rank ("the highest week") is not a ranking this can do; a time word is not a concept
    if (by || listed || ranked) return { op: "rank", ...(by ? { by } : {}), ...(order ? { order } : {}), ...(n ? { top: n } : {}) };
    return null;
  }

  // a breakdown: split by a concept the pack has
  if (by && (new RegExp(`\\b(by|per|each|every|across|split by|broken down by|break(ing)? down by)\\s+(the\\s+)?${norm(by)}s?\\b`).test(q) || /\bbreak(ing)?\s*down\b|\bbreakdown\b/.test(q))) return { op: "breakdown", by };
  if (/\bbreak(ing)?\s*down\b|\bbreakdown\b/.test(q)) return { op: "breakdown" };
  return null;
}
