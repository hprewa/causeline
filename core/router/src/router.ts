import { statusSentence, type AgentDef, type Ontology, type Route, type RouteOption, type Task } from "@causeline/schema";

/**
 * The router: a plain question to a KPI, a task and an expert. Deterministic, no LLM, no data access:
 * it reads the ontology (KPI names and synonyms), the experts available and the period labels it is
 * given, and it says what it chose so the user can redirect. Every miss in the routing evals becomes a
 * synonym or a rule here.
 */

export interface RouterInput {
  question: string;
  ontology: Ontology;
  /** The pack's own experts; the generic ones for every KPI are added here. */
  agents: AgentDef[];
  /** Playbooks that exist (the pack's and the core's), by name. */
  playbooks: string[];
  /** Labels of the top time level, oldest first, complete periods only. */
  periods: string[];
  /** Optional: values of a concept (a hierarchy level or dimension) by concept, to recognise "A versus B". */
  members?: Record<string, string[]>;
}

/** The core template each task uses when an expert names no playbook of its own. */
export const CORE_PLAYBOOK: Record<Task, string> = { value: "value", compare: "compare", trend: "trend", deep_rca: "metric_change" };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s: string) => norm(s).split(" ").filter(Boolean).map(stem);

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// --- KPI ----------------------------------------------------------------------------------------------

/** The phrase appears in the question with at most one misspelt word (words of four letters or more). */
function nearPhrase(qWords: string[], phrase: string[]): boolean {
  for (let i = 0; i + phrase.length <= qWords.length; i++) {
    let typos = 0;
    let ok = true;
    for (let j = 0; j < phrase.length && ok; j++) {
      const [q, p] = [qWords[i + j], phrase[j]];
      if (q === p) continue;
      if (p.length >= 4 && q.length >= 3 && editDistance(q, p) === 1 && ++typos <= 1) continue;
      ok = false;
    }
    if (ok && typos === 1) return true;
  }
  return false;
}

export interface KpiHit {
  kpi: string;
  /** 1 for the KPI's own name, a bit less for a synonym or a near spelling. */
  score: number;
  via: string;
}

export function matchKpis(question: string, ont: Ontology): KpiHit[] {
  const qWords = words(question);
  const padded = ` ${qWords.join(" ")} `;
  const hits: KpiHit[] = [];
  for (const [kpi, m] of Object.entries(ont.metrics)) {
    const terms = [{ text: kpi, base: 1 }, ...(m.synonyms ?? []).map((s) => ({ text: s, base: 0.9 }))];
    let best: KpiHit | null = null;
    for (const t of terms) {
      const tw = words(t.text);
      const phrase = ` ${tw.join(" ")} `;
      let score = 0;
      if (padded.includes(phrase)) score = t.base * (0.9 + Math.min(0.1, tw.length * 0.03)); // longer phrases are more specific
      // a typo, but only for the KPI's own name or a synonym long enough that a near spelling is not another word (send, spend)
      else if ((t.base === 1 || tw.join('').length >= 6) && nearPhrase(qWords, tw)) score = t.base * 0.7;
      if (score > 0 && (!best || score > best.score)) best = { kpi, score, via: t.text };
    }
    if (best) hits.push(best);
  }
  return hits.sort((a, b) => b.score - a.score);
}

// --- task ---------------------------------------------------------------------------------------------

const TASK_RULES: { task: Task; note?: string; re: RegExp }[] = [
  { task: "compare", re: /\b(vs\.?|versus|compare[ds]?|comparison|difference between|against|better than|worse than)\b/ },
  { task: "trend", re: /\b(trend\w*|over time|moving|history|week by week|week over week|so far|recent weeks|past \d+ weeks|last \d+ weeks|since)\b/ },
  { task: "deep_rca", note: "mix is analysed as part of the deep dive", re: /\b(mix|composition)\b/ },
  { task: "deep_rca", re: /\b(why|cause[ds]?|reason|root cause|explain|what happened|what went wrong|drop(ped)?|dip(ped)?|fell|fall(en)?|declin\w*|worse|wrong|unusual|spike[ds]?|surge[ds]?|jump(ed)?|went (up|down)|go(ing)? (up|down)|increase[ds]?|decrease[ds]?|hiding|anything)\b/ },
  { task: "value", re: /\b(what (was|is|were|are)|how (many|much)|value|number|level|total|show me|tell me)\b/ },
];

function classifyTask(question: string): { task: Task | null; note?: string; certain: boolean } {
  const q = norm(question).replace(/\bvs \b/, "vs ");
  const raw = question.toLowerCase();
  for (const r of TASK_RULES) if (r.re.test(q) || r.re.test(raw)) return { task: r.task, note: r.note, certain: true };
  return { task: null, certain: false };
}

/** A question about how things are, with no KPI named: worth scanning every KPI for what moved. */
const VAGUE = /\b(bad|wrong|unusual|odd|strange|happened|problems?|issues?|off|concerning|not good|trouble|unwell)\b/;

// --- periods ------------------------------------------------------------------------------------------

/** Period labels the question refers to, in the order it names them, resolved against the labels that exist. */
export function resolvePeriods(question: string, periods: string[], levelName: string): string[] {
  const q = question.toLowerCase();
  const found: { at: number; label: string }[] = [];
  const add = (at: number, label: string | undefined) => label && !found.some((f) => f.label === label) && found.push({ at, label });
  for (const label of periods) {
    const i = q.indexOf(label.toLowerCase());
    if (i >= 0) add(i, label);
  }
  const level = levelName.toLowerCase();
  const number = new RegExp(`\\b(?:${level}|wk|w)\\s*#?0*(\\d{1,3})\\b`, "g");
  for (const m of q.matchAll(number)) {
    const n = Number(m[1]);
    const label = periods.find((p) => (p.match(/\d+/g) ?? []).map(Number).pop() === n);
    add(m.index ?? 0, label);
  }
  const last = periods.length - 1;
  const rel: [RegExp, number][] = [
    [new RegExp(`\\b(?:the )?${level} before last\\b|\\btwo ${level}s ago\\b`), last - 1],
    [new RegExp(`\\b(?:last|previous|prior|latest|most recent) ${level}\\b`), last],
    [new RegExp(`\\bthis ${level}\\b`), last],
  ];
  for (const [re, idx] of rel) {
    const m = re.exec(q);
    if (m) add(m.index, periods[idx]);
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.label);
}

// --- experts --------------------------------------------------------------------------------------------

/** The pack's own experts, plus a generic draft expert for every KPI and task nobody wrote one for. */
export function effectiveExperts(ont: Ontology, agents: AgentDef[]): AgentDef[] {
  const out = [...agents];
  for (const kpi of Object.keys(ont.metrics)) {
    for (const task of ["value", "compare", "trend", "deep_rca"] as Task[]) {
      if (!out.some((a) => a.kpi === kpi && a.task === task)) out.push({ name: `${kpi}-${task}`, kpi, task, examples: [], handoff: "none", status: "draft", unconfirmed_numbers: false, ladder: 2 });
    }
  }
  return out;
}

const plain = (s: string) => s.replace(/_/g, " ");

function announceFor(kpi: string, task: Task, inputs: Record<string, string | number | boolean>, expert: AgentDef): string {
  const when = inputs.period ? ` in ${inputs.period}` : "";
  const what: Record<Task, string> = {
    value: `how ${plain(kpi)} stood${when}`,
    compare: inputs.concept ? `${plain(kpi)} for ${inputs.a} against ${inputs.b}${when}` : `${plain(kpi)} in ${inputs.period} against ${inputs.against}`,
    trend: `how ${plain(kpi)} has moved over time`,
    deep_rca: `why ${plain(kpi)} changed${when}, and where`,
  };
  return `I will check ${what[task]}. This expert ${statusSentence(expert.status, expert.unconfirmed_numbers)}.`;
}

// --- route ------------------------------------------------------------------------------------------------

export function route(input: RouterInput): Route {
  const { question, ontology: ont, periods } = input;
  const experts = effectiveExperts(ont, input.agents);
  const level = ont.time.levels[0];
  const explorer = (reason: string): Route => ({
    question,
    strategy: "explorer",
    options: [{ kpi: null, task: null, expert: "explorer", playbook: null, inputs: {}, status: "exploratory", confidence: 0.3, reasons: [reason] }],
    needs: null,
    announce: `${reason} I will treat this as an exploratory question; no expert covers it, so the answer is not from a tested expert.`,
  });

  const hits = matchKpis(question, ont);
  const taskGuess = classifyTask(question);
  const refs = resolvePeriods(question, periods, level);

  // --- no KPI named ---------------------------------------------------------------------------------------
  if (hits.length === 0) {
    if (VAGUE.test(question.toLowerCase()) || (/\bwhy\b/.test(question.toLowerCase()) && refs.length > 0)) {
      const period = refs[0];
      const needs = period ? null : { input: "period", question: `Which ${level} should I look at?`, choices: periods.slice(-3).reverse() };
      return {
        question,
        strategy: "scan",
        options: Object.keys(ont.metrics).map((kpi) => {
          const e = experts.find((x) => x.kpi === kpi && x.task === "deep_rca")!;
          const playbook = e.playbook && input.playbooks.includes(e.playbook) ? e.playbook : CORE_PLAYBOOK.deep_rca;
          return { kpi, task: "deep_rca" as Task, expert: e.name, playbook, inputs: (period ? { metric: kpi, period } : { metric: kpi }) as Record<string, string>, status: e.status, confidence: 0.4, reasons: ["no KPI was named: every KPI is checked and the ones that moved are explained"] };
        }),
        needs,
        announce: period ? `You did not name a KPI, so I will check every KPI for ${period} and look into the ones that moved.` : `You did not name a KPI, so I will check every KPI and look into the ones that moved.`,
        ...(period ? { scan: { period } } : {}),
      };
    }
    return explorer("No KPI I know matches that question.");
  }

  // --- a KPI --------------------------------------------------------------------------------------------------
  const top = hits[0];
  const tied = hits.filter((h) => h.score >= top.score - 1e-9 && h.kpi !== top.kpi);
  const reasons: string[] = [`"${top.via}" matches the KPI ${top.kpi}`];
  let task: Task = taskGuess.task ?? "value";
  if (!taskGuess.certain) reasons.push("no question word pointed at a task, so I assumed you want the number");
  if (taskGuess.note) reasons.push(taskGuess.note);
  const def = ont.metrics[top.kpi];
  if (def.type === "product" && task !== "deep_rca") {
    reasons.push(`${top.kpi} is a product of ${def.drivers.join(" and ")}; only why it changed is available, so I will look at that`);
    task = "deep_rca";
  }

  const expert = experts.find((e) => e.kpi === top.kpi && e.task === task)!;
  const playbook = expert.playbook && input.playbooks.includes(expert.playbook) ? expert.playbook : CORE_PLAYBOOK[task];
  const inputs: Record<string, string | number | boolean> = { metric: top.kpi };
  let needs: Route["needs"] = null;

  if (tied.length > 0) {
    needs = { input: "kpi", question: `Did you mean ${[top.kpi, ...tied.map((t) => t.kpi)].map(plain).join(" or ")}?`, choices: [top.kpi, ...tied.map((t) => t.kpi)] };
  }
  if (task === "compare") {
    const members = input.members ?? {};
    const q = question.toLowerCase();
    const named = Object.entries(members)
      .map(([concept, values]) => ({ concept, values: values.filter((v) => new RegExp(`(^|[^a-z0-9])${v.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(q)).sort((a, b) => q.indexOf(a.toLowerCase()) - q.indexOf(b.toLowerCase())) }))
      .find((c) => c.values.length >= 2);
    if (refs.length >= 2) {
      inputs.period = refs[0];
      inputs.against = refs[1];
    } else if (named) {
      inputs.concept = named.concept;
      inputs.a = named.values[0];
      inputs.b = named.values[1];
      inputs.period = refs[0] ?? periods[periods.length - 1];
    } else if (!needs) {
      if (refs[0]) inputs.period = refs[0];
      needs = { input: "against", question: "What should I compare it with: another period, or two values of one thing you can break it down by?" };
    }
  } else if (refs[0]) {
    inputs.period = refs[0];
  } else if (task === "trend") {
    inputs.period = periods[periods.length - 1];
    reasons.push(`no ${level} named, so the trend runs up to the latest complete ${level}`);
  } else if (!needs) {
    needs = { input: "period", question: `Which ${level} should I look at?`, choices: periods.slice(-3).reverse() };
  }

  const status = expert.status;
  const confidence = Math.max(0.1, Math.min(1, top.score * (taskGuess.certain ? 1 : 0.75) * (needs ? 0.7 : 1)));
  const option: RouteOption = { kpi: top.kpi, task, expert: expert.name, playbook, inputs, status, confidence: Math.round(confidence * 100) / 100, reasons };

  const others: RouteOption[] = hits.slice(1, 3).map((h) => {
    const e = experts.find((x) => x.kpi === h.kpi && x.task === task) ?? experts.find((x) => x.kpi === h.kpi)!;
    return { kpi: h.kpi, task: e.task, expert: e.name, playbook: e.playbook ?? CORE_PLAYBOOK[e.task], inputs: { ...inputs, metric: h.kpi }, status: e.status, confidence: Math.round(h.score * 0.5 * 100) / 100, reasons: [`"${h.via}" also matches ${h.kpi}`] };
  });

  return {
    question,
    strategy: "expert",
    options: [option, ...others],
    needs,
    announce: needs ? `I think you are asking about ${plain(top.kpi)}. ${needs.question}` : announceFor(top.kpi, task, inputs, expert),
  };
}
