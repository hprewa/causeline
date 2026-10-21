import type { Expectation, Result } from "@causeline/schema";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface Score {
  pass: boolean;
  checks: Check[];
}

const finish = (checks: Check[]): Score => ({ pass: checks.every((c) => c.ok), checks });
/** Case-insensitive, and blind to hyphen/underscore/space differences ("data_quality" matches "data-quality"). */
const squash = (t: string) => t.toLowerCase().replace(/[-_\s]+/g, " ");
const has = (haystack: string, needle: string) => squash(haystack).includes(squash(needle));

/**
 * Does the narrative name this value? Either verbatim, or by what is distinctive in it once dates
 * are set aside: a person writes "12:00-12:30 on 11 Feb" for the label "2026-02-11 12:00..2026-02-11 12:30".
 */
export function namesValue(narrative: string, value: string): boolean {
  if (has(narrative, value)) return true;
  const rest = value.replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const tokens = rest.split(/[^A-Za-z0-9_:]+/).filter((t) => t.length > 0);
  return tokens.length > 0 && rest !== value && tokens.every((t) => has(narrative, t));
}

/** Everything the run says about where the change is, as one searchable string. */
function resultText(result: Result): string {
  return JSON.stringify({ findings: result.findings, path: result.path, flags: result.masking_flags, stopped: result.stopped_detail, evidence: result.evidence });
}

/**
 * Runner-level score: deterministic, no LLM. Does the result carry the answer
 * the case expects?
 */
export function scoreRunner(result: Result, expect: Expectation): Score {
  const checks: Check[] = [];

  if (expect.top_finding) {
    const want = expect.top_finding;
    const top = result.findings[0];
    const found = top ? `${top.dimension}=${top.value}${top.scope ? ` @ ${JSON.stringify(top.scope)}` : ""}` : "no findings";
    checks.push({ name: "top_finding", ok: !!top && top.dimension === want.dimension && top.value === want.value, detail: `expected ${want.dimension}=${want.value}, got ${found}` });
    if (want.scope) {
      const scope = top?.scope ?? {};
      checks.push({
        name: "top_finding.scope",
        ok: Object.entries(want.scope).every(([k, v]) => scope[k] === v),
        detail: `expected ${JSON.stringify(want.scope)}, got ${JSON.stringify(scope)}`,
      });
    }
    if (want.effect) {
      checks.push({ name: "top_finding.effect", ok: top?.effect === want.effect, detail: `expected ${want.effect}, got ${top?.effect ?? "none"}` });
    }
    if (want.metric) {
      checks.push({ name: "top_finding.metric", ok: top?.metric === want.metric, detail: `expected ${want.metric}, got ${top?.metric ?? "none"}` });
    }
  }
  for (const want of expect.findings_include ?? []) {
    const hit = result.findings.some(
      (f) => f.dimension === want.dimension && f.value === want.value && Object.entries(want.scope ?? {}).every(([k, v]) => f.scope?.[k] === v) && (want.effect === undefined || f.effect === want.effect) && (want.metric === undefined || f.metric === want.metric),
    );
    checks.push({ name: `finding_included:${want.dimension}=${want.value}`, ok: hit, detail: `findings: ${result.findings.map((f) => `${f.dimension}=${f.value}`).join("; ") || "none"}` });
  }
  for (const want of expect.handoffs_include ?? []) {
    const h = result.handoffs.find((x) => x.metric === want.metric);
    checks.push({ name: `handoff:${want.metric}`, ok: !!h && h.headline?.significant === (want.significant ?? true), detail: h ? `handed over to ${h.metric}; its change is ${h.headline?.significant ? "real" : "not real"}` : `hand-offs: ${result.handoffs.map((x) => x.metric).join(", ") || "none"}` });
  }
  if (expect.no_handoffs) {
    checks.push({ name: "no_handoffs", ok: result.handoffs.length === 0, detail: `hand-offs: ${result.handoffs.map((x) => x.metric).join(", ") || "none"}` });
  }
  if (expect.stopped_reason) {
    checks.push({ name: "stopped_reason", ok: result.stopped_reason === expect.stopped_reason, detail: `expected ${expect.stopped_reason}, got ${result.stopped_reason ?? "none"}` });
  }
  if (expect.no_findings) {
    checks.push({ name: "no_findings", ok: result.status === "complete" && result.findings.length === 0, detail: `got ${result.status} with ${result.findings.length} finding(s)` });
  }
  for (const flag of expect.masking_flags ?? []) {
    checks.push({ name: `masking_flag:${flag}`, ok: result.masking_flags.some((f) => f.type === flag), detail: `flags raised: ${result.masking_flags.map((f) => f.type).join(", ") || "none"}` });
  }
  if (expect.significant !== undefined) {
    checks.push({ name: "significant", ok: result.headline?.significant === expect.significant, detail: `expected ${expect.significant}, got ${result.headline?.significant ?? "no headline"} (z ${result.headline?.z?.toFixed(1) ?? "n/a"})` });
  }
  for (const p of expect.change_points_include ?? []) {
    checks.push({ name: `change_point:${p}`, ok: !!result.trend?.change_points.includes(p), detail: `change points: ${result.trend?.change_points.join(", ") || "none"}` });
  }
  if (expect.no_change_points) {
    checks.push({ name: "no_change_points", ok: !!result.trend && result.trend.change_points.length === 0, detail: `change points: ${result.trend?.change_points.join(", ") || "none"}` });
  }
  if (expect.comparison_significant !== undefined) {
    checks.push({ name: "comparison_significant", ok: result.comparison?.significant === expect.comparison_significant, detail: `expected ${expect.comparison_significant}, got ${result.comparison?.significant ?? "no comparison"} (z ${result.comparison?.z.toFixed(1) ?? "n/a"})` });
  }
  for (const want of expect.evidence ?? []) {
    const got = result.evidence.find((e) => e.source === want.source);
    const records = JSON.stringify(got?.sample ?? []).toLowerCase();
    checks.push({ name: `evidence:${want.source}`, ok: !!got && got.rows >= want.min_rows, detail: got ? `${got.rows} record(s)${got.skipped ? `, skipped: ${got.skipped}` : ""}` : "the source was never asked" });
    for (const w of want.contains ?? []) checks.push({ name: `evidence:${want.source}:contains:${w}`, ok: records.includes(w.toLowerCase()) });
    for (const w of want.excludes ?? []) checks.push({ name: `evidence:${want.source}:excludes:${w}`, ok: !records.includes(w.toLowerCase()) });
  }
  const text = resultText(result);
  for (const needle of expect.must_mention ?? []) {
    checks.push({ name: `must_mention:${needle}`, ok: has(text, needle) });
  }
  // at runner level a "claim" is a finding or the stop reason, not every node the drill visited
  const claims = JSON.stringify({ findings: result.findings, stopped: [result.stopped_reason, result.stopped_detail] });
  for (const needle of expect.must_not_claim ?? []) {
    checks.push({ name: `must_not_claim:${needle}`, ok: !has(claims, needle) });
  }
  return finish(checks);
}

/** Standalone numbers in prose: not part of an identifier or date (site_02, W10, 2026-03-11). */
const NUMBER = /(?<![\w.-])-?\d+(?:\.\d+)?(?![\w-])/g;

/** "3,163" is one number, not 3 and 163. */
const withoutThousandsCommas = (text: string) => text.replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");

export function numbersIn(text: string): number[] {
  return [...withoutThousandsCommas(text).matchAll(NUMBER)].map((m) => Number(m[0]));
}

function decimals(token: string): number {
  const dot = token.indexOf(".");
  return dot < 0 ? 0 : token.length - dot - 1;
}

/** Every numeric value a result can legitimately be quoted from, including digits inside labels. */
function allowedNumbers(...sources: unknown[]): number[] {
  const out: number[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "string") out.push(...numbersIn(v), ...[...v.matchAll(/\d+/g)].map((m) => Number(m[0])));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  sources.forEach(visit);
  return out;
}

/**
 * Numbers in the narrative that cannot be traced to the result (or the
 * question, or a neighbouring period). A figure counts as traced when it matches a result value, a
 * percentage form of it (x100), or either with the sign flipped, within the
 * rounding the narrative itself used.
 */
export function untracedNumbers(narrative: string, result: Result | null, question: string): string[] {
  const allowed = allowedNumbers(result, question);
  // offering to rerun the neighbouring periods ("week 6 or 8" after a question about week 7) is not
  // a statistic: whole numbers one step either side of the period or the question's own are fine
  for (const n of allowedNumbers(result?.inputs?.period, question)) if (Number.isInteger(n)) allowed.push(n - 1, n + 1);
  const bad: string[] = [];
  for (const m of withoutThousandsCommas(narrative).matchAll(NUMBER)) {
    const token = m[0];
    const value = Math.abs(Number(token));
    const tol = 0.5 * Math.pow(10, -decimals(token)) + 1e-9;
    const traced = allowed.some((a) => [Math.abs(a), Math.abs(a) * 100].some((c) => Math.abs(c - value) <= tol));
    if (!traced) bad.push(token);
  }
  return bad;
}

export interface AgentEvidence {
  narrative: string;
  /** Every tool call the agent made (name as the client reports it, and its input). */
  toolCalls: { name: string; input: unknown }[];
  /** The result.json the agent's run_playbook call returned, if any. */
  result: Result | null;
  question: string;
  expectedPlaybook: string;
}

/**
 * Agent-level score: did the LLM pick the right playbook, describe what the
 * result says, and avoid inventing numbers or claims?
 */
export function scoreAgent(ev: AgentEvidence, expect: Expectation): Score {
  const checks: Check[] = [];
  const called = ev.toolCalls.filter((t) => /run_playbook$/.test(t.name));
  const picked = called.map((t) => (t.input as { name?: string } | undefined)?.name);
  // the running intent picks the playbook itself: the one it ran is in the result it returned
  if (ev.toolCalls.some((t) => /run_intent$/.test(t.name)) && ev.result) picked.push(ev.result.playbook);
  checks.push({ name: "playbook_called", ok: picked.includes(ev.expectedPlaybook), detail: `playbooks run: ${picked.join(", ") || "none"}` });
  checks.push({ name: "result_available", ok: ev.result !== null, detail: ev.result ? undefined : "no result.json came back from run_playbook" });

  if (expect.top_finding) {
    const want = expect.top_finding;
    const scopeValues = Object.values(want.scope ?? {});
    checks.push({
      name: "narrative_names_top_finding",
      ok: namesValue(ev.narrative, want.value) && scopeValues.every((v) => has(ev.narrative, v)),
      detail: `looking for ${[want.value, ...scopeValues].join(", ")}`,
    });
  }
  if (expect.stopped_reason) {
    checks.push({ name: "narrative_reports_stop", ok: has(ev.narrative, expect.stopped_reason.replace(/_/g, " ")) || has(ev.narrative, expect.stopped_reason), detail: `looking for "${expect.stopped_reason}"` });
  }
  for (const needle of expect.must_mention ?? []) checks.push({ name: `must_mention:${needle}`, ok: has(ev.narrative, needle) });
  for (const needle of expect.must_not_claim ?? []) checks.push({ name: `must_not_claim:${needle}`, ok: !has(ev.narrative, needle) });

  const untraced = untracedNumbers(ev.narrative, ev.result, ev.question);
  checks.push({ name: "numbers_traceable", ok: untraced.length === 0, detail: untraced.length ? `not in the result: ${untraced.join(", ")}` : undefined });
  return finish(checks);
}
