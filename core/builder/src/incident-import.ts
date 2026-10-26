import { ScopedToolCaller, ToolIndex, toBuckets, toChildRows, type ToolCaller } from "@causeline/runner";
import { completeBuckets, resolvePeriods } from "@causeline/router";
import { loadPack } from "@causeline/schema";
import { dayWords } from "./checks.js";
import { readState } from "./state.js";

/**
 * Turn a past incident the person described in their own words (a post-mortem, an email, a sentence) into the exact arguments for recording it,
 * after checking it against the data. The assistant reads the text and fills in what it understood (when, where, how the person would ask); this
 * does the checking, with no model call: the period must exist, the dimension must be one the data can be broken down by, and the value must be
 * a real value that had volume in that window. What cannot be resolved is said, with the values that do exist, so the person can correct it
 * instead of a wrong incident being recorded (a wrong incident would make `verified` mean nothing).
 */
export interface ProposeIncidentInput {
  workspace: string;
  kpi: string;
  tools: ToolCaller;
  /** The text the person pasted, kept as the incident's wording when no question is given. */
  text?: string;
  /** When it happened in the person's words ("week 7", "the week of 12 September"). */
  period_words?: string;
  start_date?: string;
  end_date?: string;
  finding: { dimension: string; value: string; scope?: Record<string, string> };
  question?: string;
  mention?: string[];
  held_out?: boolean;
}

export interface IncidentProposal {
  ok: boolean;
  /** What is wrong or unresolved, in plain words. */
  problems: string[];
  /** The values that do exist, when the one given was not among them. */
  suggestions?: { dimension: string; values: string[] };
  /** The window the incident was resolved to. */
  when?: { period?: string; start: string; end: string; words: string };
  /** Exactly the arguments for `add_incident`, for the person to confirm. */
  add_incident?: Record<string, unknown>;
  held_out: boolean;
  /** Said to the person: what is being recorded, and what keeping it aside means. */
  say: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function proposeIncident(opts: ProposeIncidentInput): Promise<IncidentProposal> {
  const pack = loadPack(opts.workspace, { requireMeta: true });
  const state = readState(opts.workspace);
  if (!state) throw new Error("this workspace has not been set up yet");
  const problems: string[] = [];
  const def = pack.ontology.metrics[opts.kpi];
  if (!def) throw new Error(`"${opts.kpi}" is not a KPI in this pack (have: ${Object.keys(pack.ontology.metrics).join(", ")})`);
  const held_out = opts.held_out ?? state.incidents.filter((i) => i.kpi === opts.kpi).length >= 1;
  const concepts = [...Object.values(pack.ontology.hierarchies).flat(), ...pack.ontology.dimensions];
  for (const c of [opts.finding.dimension, ...Object.keys(opts.finding.scope ?? {})]) {
    if (!concepts.includes(c)) problems.push(`"${c}" is not something this data can be broken down by (it can be: ${concepts.slice(0, 12).join(", ")}${concepts.length > 12 ? ", ..." : ""}).`);
  }

  const index = new ToolIndex(pack.meta!);
  const levels = pack.ontology.time.levels;
  const periods = await completeBuckets(opts.tools, index, opts.kpi, levels[0]);
  if (periods.length === 0) throw new Error("the data has no complete period to place an incident in");
  const covers = `${dayWords(periods[0].bucket_start.slice(0, 10), periods[periods.length - 1].bucket_end.slice(0, 10))}`;

  // when
  let when: IncidentProposal["when"];
  let window: { start: string; end: string } | undefined;
  if (opts.start_date || opts.end_date) {
    if (!opts.start_date || !opts.end_date || !ISO.test(opts.start_date) || !ISO.test(opts.end_date)) problems.push("Dates need a first and a last day, written YYYY-MM-DD.");
    else if (opts.start_date > opts.end_date) problems.push("The first day is after the last day.");
    else {
      const first = periods[0].bucket_start.slice(0, 10);
      const last = periods[periods.length - 1].bucket_end.slice(0, 10);
      if (opts.end_date < first || opts.start_date > last) problems.push(`That is outside the data, which covers ${covers}.`);
      else {
        const fine = levels.includes("day") ? "day" : (levels[1] ?? levels[0]);
        const counts = (await opts.tools.call(index.extent(opts.kpi), {}, "incident"))[0];
        const days = toBuckets(await opts.tools.call(index.series(opts.kpi, fine), { start: String(counts.min_ts), end: String(counts.max_ts) }, "incident")).filter((b) => b.bucket_start.slice(0, 10) >= opts.start_date! && b.bucket_end.slice(0, 10) <= opts.end_date!);
        if (days.length === 0) problems.push("No whole day of the data falls inside those dates.");
        else {
          window = { start: days[0].bucket_start, end: days[days.length - 1].bucket_end };
          when = { start: opts.start_date, end: opts.end_date, words: dayWords(opts.start_date, opts.end_date) };
        }
      }
    }
  } else if (opts.period_words?.trim()) {
    const found = resolvePeriods(opts.period_words, periods.map((p) => p.bucket), levels[0]);
    if (found.length === 0) problems.push(`I could not tell which ${levels[0]} "${opts.period_words}" means. The data covers ${covers}; give the dates or the ${levels[0]}'s label (for example ${periods[periods.length - 1].bucket}).`);
    else if (found.length > 1) problems.push(`"${opts.period_words}" could mean ${found.join(" or ")}. Which one?`);
    else {
      const b = periods.find((p) => p.bucket === found[0])!;
      window = { start: b.bucket_start, end: b.bucket_end };
      when = { period: b.bucket, start: b.bucket_start.slice(0, 10), end: b.bucket_end.slice(0, 10), words: dayWords(b.bucket_start.slice(0, 10), b.bucket_end.slice(0, 10)) };
    }
  } else problems.push("When did it happen? Give a period or two dates.");

  // where: the value must be a real one with volume in that window
  let suggestions: IncidentProposal["suggestions"];
  if (window && problems.length === 0) {
    const scope = opts.finding.scope ?? {};
    const caller = Object.keys(scope).length > 0 ? new ScopedToolCaller(opts.tools, pack.meta!, scope) : opts.tools;
    const rows = toChildRows(await caller.call(index.slice(opts.kpi, opts.finding.dimension), { cur_start: window.start, cur_end: window.end, base_start: window.start, base_end: window.end }, "incident"));
    const here = rows.filter((r) => r.cur.den > 0).sort((a, b) => b.cur.den - a.cur.den);
    const exact = here.find((r) => r.node === opts.finding.value) ?? here.find((r) => r.node.toLowerCase() === opts.finding.value.toLowerCase());
    if (!exact) {
      suggestions = { dimension: opts.finding.dimension, values: here.slice(0, 8).map((r) => r.node) };
      problems.push(`"${opts.finding.value}" is not a ${opts.finding.dimension.replace(/_/g, " ")} that has any activity in ${when!.words}${Object.keys(scope).length > 0 ? ` within ${Object.entries(scope).map(([c, v]) => `${c.replace(/_/g, " ")} ${v}`).join(", ")}` : ""}. The ones that do include: ${here.slice(0, 8).map((r) => r.node).join(", ") || "none"}.`);
    } else opts.finding.value = exact.node;
  }

  const question = opts.question?.trim() || (opts.text ? `Why did ${opts.kpi.replace(/_/g, " ")} change${when ? ` in ${when.words}` : ""}?` : "");
  if (!question) problems.push("What question would the person ask about it? (for example 'Why did service level drop in week 7?')");
  const ok = problems.length === 0;
  const add_incident = ok
    ? {
        kpi: opts.kpi,
        ...(when!.period ? { period: when!.period } : { period: "", start_date: when!.start, end_date: when!.end }),
        finding: { dimension: opts.finding.dimension, value: opts.finding.value, ...(opts.finding.scope && Object.keys(opts.finding.scope).length > 0 ? { scope: opts.finding.scope } : {}) },
        question,
        ...(opts.mention?.length ? { mention: opts.mention } : {}),
        held_out,
      }
    : undefined;
  const keep = held_out ? " It will be kept aside: it is only looked at at the end, to check the analysis, and never used to adjust anything." : " It is the first one, so it can help while the analysis is set up; keep the next one aside.";
  return {
    ok,
    problems,
    ...(suggestions ? { suggestions } : {}),
    ...(when ? { when } : {}),
    ...(add_incident ? { add_incident } : {}),
    held_out,
    say: ok ? `This would record: in ${when!.words}, ${opts.finding.value} (${opts.finding.dimension.replace(/_/g, " ")}${Object.keys(opts.finding.scope ?? {}).length > 0 ? ` within ${Object.entries(opts.finding.scope!).map(([c, v]) => `${c.replace(/_/g, " ")} ${v}`).join(", ")}` : ""}) is what moved ${opts.kpi.replace(/_/g, " ")}.${keep}` : problems.join(" "),
  };
}
