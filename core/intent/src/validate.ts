import { conceptsOf, type Intent, type IntentCheck, type IntentOption, type IntentSlot, type Ontology, type Task } from "@causeline/schema";
import { matchKpis } from "@causeline/router";
import { dayText, parseDay } from "./calendar.js";
import { playback } from "./playback.js";
import { resolveAgainst, resolveSpec, toWindow, type PeriodContext, type Span } from "./period.js";

/** What a question is checked against. All of it is read from the pack and its data; none of it is guessed. */
export interface IntentEnv {
  ontology: Ontology;
  /** The real date, as YYYY-MM-DD. Ignored for data that stops at a fixed date (`as_of: data_end`). */
  today: string;
  as_of: "today" | "data_end";
  /** The first and last day the data holds. */
  data: { start: string; end: string };
  /** Labels of the data's top time level, with the days they cover. */
  labels: { label: string; start: string; end: string }[];
  /** The values a concept takes for a KPI, from the data. */
  lookup: (kpi: string, concept: string) => Promise<string[]>;
}

const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]+/g, " ").trim();

const ask = (slot: IntentSlot, question: string, options: IntentOption[] = [], detail?: string): IntentCheck => ({ status: "ask", slot, question, options, ...(detail ? { detail } : {}) });

const TASK_OPTIONS: IntentOption[] = [
  { value: "value", label: "the number for a period" },
  { value: "compare", label: "a comparison of two periods or groups" },
  { value: "trend", label: "how it has moved over time" },
  { value: "deep_rca", label: "a deep dive into why it changed" },
];

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // two neighbouring letters swapped is one slip, not two
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

/** The closest of `names` to `text`, best first: a near spelling, or one containing the other. */
export function closest(text: string, names: string[], limit = 5): string[] {
  const t = norm(text);
  return names
    .map((n) => ({ n, d: norm(n) === t ? 0 : norm(n).includes(t) || t.includes(norm(n)) ? 1 : editDistance(norm(n), t) }))
    .filter((x) => x.d <= Math.max(1, Math.floor(t.length / 4)))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, limit)
    .map((x) => x.n);
}

/** Days a bucket of a built-in time level spans (shorter than that and the level makes no sense for the window). */
const LEVEL_DAYS: Record<string, number> = { year: 365, quarter: 90, month: 28, week: 7, day: 1 };

/** "daily", "by day", "Weeks", "half-hourly" -> the ontology's level, or null. */
export function matchLevel(text: string, levels: string[]): string | null {
  let t = norm(text).replace(/^(by|per|each|every)\s+/, "");
  const direct = (x: string) => levels.find((l) => norm(l) === x) ?? levels.find((l) => norm(l) === x.replace(/s$/, "")) ?? null;
  const hit = direct(t);
  if (hit) return hit;
  if (/ily$/.test(t)) t = t.replace(/ily$/, "y");
  else if (/ly$/.test(t)) t = t.replace(/ly$/, "");
  return direct(t);
}

/**
 * Check an intent against the pack and its data. The result is either a ready, fully resolved intent with a
 * plain-words play-back, or the one question to ask next. Pure apart from the lookup it is given; nothing here
 * asks a model, so the same intent and the same data always give the same answer.
 */
export async function validateIntent(intent: Intent, env: IntentEnv): Promise<IntentCheck> {
  const ont = env.ontology;
  const notes: string[] = [];

  // --- KPI
  const kpis = Object.keys(ont.metrics);
  if (!intent.kpi) return ask("kpi", "Which KPI do you want to look at?", kpis.map((k) => ({ value: k, label: k.replace(/_/g, " ") })));
  let kpi = kpis.find((k) => norm(k) === norm(intent.kpi!));
  if (!kpi) {
    const hits = matchKpis(intent.kpi, ont);
    if (hits.length === 0) return ask("kpi", `I don't know a KPI called "${intent.kpi}". Which of these do you mean?`, kpis.map((k) => ({ value: k, label: k.replace(/_/g, " ") })));
    if (hits.length === 1 || hits[0].score - hits[1].score >= 0.1) {
      kpi = hits[0].kpi;
      notes.push(`"${intent.kpi}" read as ${kpi.replace(/_/g, " ")}`);
    } else {
      const near = hits.filter((h) => h.score >= hits[0].score - 0.1);
      return ask("kpi", `"${intent.kpi}" could mean ${near.length} KPIs. Which one?`, near.map((h) => ({ value: h.kpi, label: h.kpi.replace(/_/g, " ") })));
    }
  }

  // --- task
  if (!intent.task) return ask("task", `What do you want to know about ${kpi.replace(/_/g, " ")}?`, TASK_OPTIONS);
  const task: Task = intent.task;

  // --- period
  if (!intent.period) {
    return ask("period", "Which period?", [
      { value: "last week", label: "last week" },
      { value: "last month", label: "last month" },
      { value: "last 4 weeks", label: "the last 4 weeks" },
    ]);
  }
  const today = env.as_of === "data_end" ? parseDay(env.data.end)! + 1 : parseDay(env.today);
  if (today === null) return ask("period", "I could not read today's date, so I cannot work out relative periods. Which dates do you mean?");
  const ctx: PeriodContext = {
    today,
    labels: env.labels.flatMap((l) => {
      const [start, end] = [parseDay(l.start), parseDay(l.end)];
      return start === null || end === null ? [] : [{ label: l.label, start, end }];
    }),
  };
  const first = resolveSpec(intent.period, ctx);
  if ("problem" in first) return ask("period", `${first.problem[0].toUpperCase()}${first.problem.slice(1)}. Which period do you mean?`, first.options);
  notes.push(...first.notes);

  // --- comparison
  let against;
  if (task === "compare" && !intent.comparison) {
    return ask("comparison", "Compare it with what?", [
      { value: "previous", label: "the period just before" },
      { value: "same_last_year", label: "the same dates a year earlier" },
    ]);
  }
  if (intent.comparison && task !== "compare") {
    return ask("task", "You mentioned two periods. Do you want a comparison of them, or a deep dive into the first?", TASK_OPTIONS.filter((o) => o.value === "compare" || o.value === "deep_rca"));
  }
  if (intent.comparison) {
    const other = resolveAgainst(intent.comparison, first.span, ctx);
    if ("problem" in other) return ask("comparison", `${other.problem[0].toUpperCase()}${other.problem.slice(1)}. Compare it with what?`, other.options);
    if (other.span.start === first.span.start && other.span.end === first.span.end) return ask("comparison", "Those are the same period. Compare it with what?");
    notes.push(...other.notes);
    against = other.span;
  }

  // --- aggregation
  let aggregation = "";
  if (intent.aggregation) {
    const level = matchLevel(intent.aggregation, ont.time.levels);
    if (!level) return ask("aggregation", `I can look at it by ${ont.time.levels.join(", ")}. Which do you want?`, ont.time.levels.map((l) => ({ value: l, label: l.replace(/_/g, " ") })));
    const days = LEVEL_DAYS[level];
    const length = first.span.end - first.span.start + 1;
    if (days !== undefined && length < days) {
      const finer = ont.time.levels.filter((l) => (LEVEL_DAYS[l] ?? 0) < days);
      return ask("aggregation", `That period is ${length} day${length === 1 ? "" : "s"} long, shorter than one ${level.replace(/_/g, " ")}. Which finer view do you want?`, finer.map((l) => ({ value: l, label: l.replace(/_/g, " ") })));
    }
    aggregation = level;
  }

  // --- filters
  const concepts = conceptsOf(ont);
  const filters: Record<string, string> = {};
  for (const [name, value] of Object.entries(intent.filters)) {
    const concept = concepts.find((c) => norm(c) === norm(name));
    if (!concept) {
      const near = closest(name, concepts);
      return ask("filters", `I can't split or filter by "${name}". I can use ${concepts.join(", ")}.`, (near.length ? near : concepts).map((c) => ({ value: c, label: c.replace(/_/g, " ") })), name);
    }
    const members = await env.lookup(kpi, concept);
    const exact = members.find((m) => norm(m) === norm(value));
    if (exact) {
      filters[concept] = exact;
      continue;
    }
    const near = closest(value, members);
    const sample = members.slice(0, 5).join(", ");
    return ask(
      "filters",
      near.length ? `I can't find ${concept} "${value}" in the data. Did you mean ${near.join(" or ")}?` : `I can't find ${concept} "${value}" in the data${members.length ? `. Some that exist: ${sample}` : ""}.`,
      near.map((m) => ({ value: m, label: m })),
      concept,
    );
  }

  // --- the data must hold the period
  const [dataStart, dataEnd] = [parseDay(env.data.start)!, parseDay(env.data.end)!];
  // a "to date" span begins by convention (1 January); data that starts later cuts it short, and says so
  const fit = (s: Span): Span => {
    if (s.clip && s.start < dataStart && s.end >= dataStart) {
      notes.push(`${s.name} starts before the data does, so it begins at ${dayText(dataStart)}, the first day the data holds`);
      return { ...s, start: dataStart };
    }
    return s;
  };
  const fitted = fit(first.span);
  const fittedAgainst = against ? fit(against) : undefined;
  const outside = (s: Span, slot: IntentSlot) =>
    s.start < dataStart || s.end > dataEnd
      ? ask(slot, `${s.name[0].toUpperCase()}${s.name.slice(1)} (${dayText(s.start)} to ${dayText(s.end)}) is not inside the data, which covers ${dayText(dataStart)} to ${dayText(dataEnd)}. Which period do you want?`)
      : null;
  const problem = outside(fitted, "period") ?? (fittedAgainst ? outside(fittedAgainst, "comparison") : null);
  if (problem) return problem;

  const resolved = {
    kpi,
    task,
    window: toWindow(fitted),
    ...(fittedAgainst ? { against: toWindow(fittedAgainst) } : {}),
    aggregation,
    filters,
    ...(intent.baseline !== undefined ? { baseline: intent.baseline } : {}),
  };
  return { status: "ready", resolved, playback: playback(resolved), notes };
}
