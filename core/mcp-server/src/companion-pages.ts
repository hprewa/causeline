import { EXPLORATORY_SAYS, statusSentence, type Exploration, type Handoff, type Result, type Rung } from "@causeline/schema";
import type { ProjectSummary } from "@causeline/builder";

/**
 * The read-only pages of the local companion pages: the project's overview, how each playbook decides what to do next, and the results of
 * past runs. They are built on the server as HTML with every value escaped, carry no script at all, and have no form or button: the only
 * page that takes input is the sign-off page.
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export type Section = "home" | "signoff" | "playbooks" | "explorations" | "results";

export const CSS = `
:root { --bg:#f6f7f9; --card:#fff; --ink:#1b1f24; --muted:#5b6672; --line:#d9dee4; --accent:#1f5fbf; --ok:#1a7f4b; --okbg:#e3f4ea; --warn:#9a5b00; --warnbg:#fdf0d8; --bad:#b3261e; --badbg:#fbe4e2; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#14171b; --card:#1d2227; --ink:#e8ebee; --muted:#9aa5b1; --line:#323a43; --accent:#6ea3f2; --ok:#6fd09a; --okbg:#163626; --warn:#f0b86a; --warnbg:#3a2d12; --bad:#f2a199; --badbg:#3b1c19; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 16px 16px 64px; }
nav { display:flex; flex-wrap:wrap; gap:4px 16px; padding:10px 0 14px; border-bottom:1px solid var(--line); margin-bottom:20px; }
nav a { color:var(--muted); text-decoration:none; padding:2px 0; border-bottom:2px solid transparent; }
nav a[aria-current="page"] { color:var(--ink); border-bottom-color:var(--accent); font-weight:600; }
h1 { font-size:1.4rem; margin:0 0 4px; } h2 { font-size:1.1rem; margin:20px 0 8px; } h3 { font-size:1rem; margin:0; }
.lede { color:var(--muted); margin:0 0 16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:0 0 12px; }
.badge { font-size:.8rem; font-weight:600; padding:2px 10px; border-radius:99px; border:1px solid currentColor; white-space:nowrap; }
.draft { color:var(--muted); } .reconciled, .calibrated { color:var(--warn); background:var(--warnbg); } .verified, .complete { color:var(--ok); background:var(--okbg); } .stopped { color:var(--bad); background:var(--badbg); }
.row { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; }
.muted { color:var(--muted); }
.banner { background:var(--warnbg); color:var(--warn); border:1px solid var(--warn); border-radius:10px; padding:10px 14px; margin:0 0 16px; }
.note { background:var(--warnbg); color:var(--warn); padding:6px 10px; border-radius:6px; margin:8px 0; }
.bad { background:var(--badbg); color:var(--bad); padding:6px 10px; border-radius:6px; margin:8px 0; }
table { border-collapse:collapse; width:100%; font-size:.95rem; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; }
td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
code { font:.9rem ui-monospace, Consolas, monospace; background:var(--bg); padding:1px 5px; border-radius:4px; }
.flow { list-style:none; margin:0; padding:0; } .flow > li { position:relative; padding:0 0 0 0; }
.step { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; }
.arrow { text-align:center; color:var(--muted); line-height:1.2; padding:2px 0; }
.rules { margin:6px 0 0 18px; padding:0; color:var(--muted); font-size:.92rem; }
a { color:var(--accent); }
details { margin:6px 0; } summary { cursor:pointer; color:var(--muted); }
@media (max-width: 520px) { table { font-size:.88rem; } }
`;

const NAV: [Section, string, string][] = [
  ["home", "home", "Overview"],
  ["signoff", "", "Sign-off"],
  ["playbooks", "playbooks", "How it decides"],
  ["explorations", "explorations", "Explorations"],
  ["results", "results", "Results"],
];

/** The page around a body: the same menu and look on every page. `base` is the path all the pages share (with the secret), ending in a slash. */
export function shell(opts: { title: string; nonce: string; base: string; active: Section; body: string }): string {
  const links = NAV.map(([s, path, label]) => `<a href="${esc(opts.base + path)}"${s === opts.active ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style nonce="${esc(opts.nonce)}">${CSS}</style>
</head>
<body>
<main>
<nav aria-label="Pages">${links}</nav>
${opts.body}
</main>
</body>
</html>`;
}

/** The navigation as markup and the styles it needs, for a page (the sign-off page) that has its own shell. */
export function navFor(base: string, active: Section): string {
  return `<nav aria-label="Pages">${NAV.map(([s, path, label]) => `<a href="${esc(base + path)}"${s === active ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("")}</nav>`;
}
export const NAV_CSS = CSS.split("\n").filter((l) => /^nav/.test(l)).join("\n");

const badge = (rung: string) => `<span class="badge ${esc(rung)}">${esc(rung)}</span>`;
const when = (iso: string | undefined | null) => (iso ? esc(iso.replace("T", " ").slice(0, 16)) : "never");

// --- overview --------------------------------------------------------------------------------------------

export function homeBody(s: ProjectSummary): string {
  const kpis = s.kpis.length
    ? `<table><thead><tr><th>KPI</th><th>How far it is trusted</th><th>What would take it further</th></tr></thead><tbody>${s.kpis
        .map((k) => `<tr><td>${esc(k.kpi.replace(/_/g, " "))}</td><td>${badge(k.level)}${k.unconfirmed ? ' <span class="muted">numbers not confirmed</span>' : ""}${k.calibration ? ` <span class="muted">raised something in ${Math.round(k.calibration.false_alarm_rate * 100)}% of ${k.calibration.quiet_periods} ordinary periods (allowed ${Math.round(k.calibration.allowed * 100)}%)</span>` : ""}</td><td class="muted">${esc(k.gap || "nothing: this is the top rung")}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No KPI is described yet.</p>`;
  const experts = s.experts.length
    ? `<table><thead><tr><th>Expert</th><th>Covers</th><th>What it can honestly say</th></tr></thead><tbody>${s.experts
        .map((e) => `<tr><td>${esc(e.name)}</td><td>${esc(e.kpi.replace(/_/g, " "))} (${esc(e.task.replace(/_/g, " "))})</td><td>${badge(e.status)} <span class="muted">It ${esc(statusSentence(e.status as Rung, e.unconfirmed_numbers))}.</span></td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No expert yet.</p>`;
  const drift = s.drift
    ? `<div class="${s.drift.ok ? "card" : "note"}"><b>${s.drift.ok ? "Checked when opened" : "Look at this first"}</b> (${when(s.drift.at)}): ${esc(s.drift.detail)}.</div>`
    : "";
  const changes = s.recent_changes.length
    ? `<table><thead><tr><th>When</th><th>What</th><th>From</th><th>To</th><th>Why</th></tr></thead><tbody>${s.recent_changes
        .slice()
        .reverse()
        .map((c) => `<tr><td>${when(c.at)}</td><td>${esc(c.subject.replace(":", " "))}</td><td>${esc(c.from)}</td><td>${esc(c.to)}</td><td class="muted">${esc(c.why)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">Nothing has changed rung yet.</p>`;
  const tables = s.data.tables.length ? s.data.tables.map((t) => `${esc(t.name)} (${esc(t.rows.toLocaleString("en-GB"))} rows)`).join(", ") : "none connected";
  const dataLine = s.tracked ? `${esc(s.data.dialect === "bigquery" ? "BigQuery" : "Files on this computer")}: ${tables}. ${esc(String(s.incidents))} past incident${s.incidents === 1 ? "" : "s"} recorded.` : "Described in the project's own files; the connection is not tracked here.";
  return `<h1>${esc(s.name)}</h1>
<p class="lede">Where this project stands. Nothing on this page changes anything; numbers are confirmed on the Sign-off page.</p>
${drift}
<div class="card"><b>Next:</b> ${esc(s.next)}</div>
<h2>KPIs</h2>${kpis}
<h2>Experts</h2>${experts}
<h2>Data</h2><p>${dataLine}</p>
<h2>Recent changes of trust</h2>${changes}`;
}

// --- how a playbook decides ------------------------------------------------------------------------------

export interface PlaybookView {
  name: string;
  description: string;
  source: "pack" | "core";
  steps: { id: string; label: string; when?: string; facts: string[]; rules: { text: string }[]; max_visits?: number }[];
}

export function playbooksBody(books: PlaybookView[], base: string): string {
  return `<h1>How it decides</h1>
<p class="lede">The steps each kind of question goes through, and what each step looks at before choosing the next. The choices are made by fixed rules in code, not by the assistant.</p>
${books.map((b) => `<div class="card"><div class="row"><h3><a href="${esc(base + "playbooks/" + encodeURIComponent(b.name))}">${esc(b.name.replace(/_/g, " "))}</a></h3><span class="muted">${b.steps.length} steps</span></div><div class="muted">${esc(b.description)}</div></div>`).join("")}`;
}

export function playbookBody(b: PlaybookView, base: string): string {
  const steps = b.steps
    .map(
      (s, i) => `${i > 0 ? '<li class="arrow" aria-hidden="true">&darr;</li>' : ""}<li><div class="step"><div class="row"><b>${esc(s.label)}</b><span class="muted"><code>${esc(s.id)}</code></span>${s.max_visits ? `<span class="muted">may run up to ${s.max_visits} times</span>` : ""}</div>${
        s.when ? `<div class="muted">Only when <code>${esc(s.when)}</code></div>` : ""
      }${s.facts.length ? `<div class="muted">Records: ${s.facts.map((f) => `<code>${esc(f)}</code>`).join(" ")}</div>` : ""}${
        s.rules.length ? `<ul class="rules">${s.rules.map((r) => `<li>${esc(r.text)}</li>`).join("")}</ul>` : ""
      }</div></li>`,
    )
    .join("");
  return `<p><a href="${esc(base + "playbooks")}">&larr; All playbooks</a></p>
<h1>${esc(b.name.replace(/_/g, " "))}</h1><p class="lede">${esc(b.description)}${b.source === "pack" ? " (this project's own)" : ""}</p>
<ol class="flow">${steps}</ol>
<p class="muted">A step with no rule goes on to the next one. A step that is skipped (its condition does not hold) is shown as skipped in the result.</p>`;
}

// --- explorations ------------------------------------------------------------------------------------------

export interface ExplorationItem {
  file: string;
  at: string;
  question: string;
  steps: number;
  refused: number;
  stopped: boolean;
}

export function explorationsBody(items: ExplorationItem[], base: string): string {
  const head = `<h1>Explorations</h1><p class="lede">Questions no expert covers, answered by reading your data in fixed ways. Every one is exploratory: it says what the data shows and makes no claim about cause.</p>`;
  if (items.length === 0) return `${head}<p class="muted">Nothing has been explored in this project yet.</p>`;
  return `${head}<table><thead><tr><th>When</th><th>The question</th><th class="n">Steps</th><th></th></tr></thead><tbody>${items
    .map((i) => `<tr><td>${when(i.at)}</td><td>${esc(i.question || "(no question recorded)")}${i.refused ? ` <span class="muted">(${i.refused} request${i.refused === 1 ? "" : "s"} refused)</span>` : ""}${i.stopped ? ' <span class="muted">(stopped at its limit)</span>' : ""}</td><td class="n">${i.steps}</td><td><a href="${esc(base + "explorations/" + encodeURIComponent(i.file))}">Open</a></td></tr>`)
    .join("")}</tbody></table>`;
}

const TRUST: Record<string, string> = { draft: "not yet checked against your reports", reconciled: "matches your reports; not tested for false alarms", calibrated: "matches your reports; stays quiet in ordinary periods", verified: "matches your reports, stays quiet, and finds known incidents" };
const show = (v: string | number | boolean | null): string => (v === null ? "" : typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : String(v));
const numeric = (c: string) => /value|volume|share|change|rank|occurrences$|^z$/.test(c);

export function explorationBody(e: Exploration, file: string, base: string): string {
  const trust = e.kpis.length ? `<p class="muted">Numbers read from: ${e.kpis.map((k) => `${esc(k.kpi.replace(/_/g, " "))} (${esc(TRUST[k.rung] ?? k.rung)})`).join("; ")}.</p>` : "";
  const steps = e.steps
    .map((s) => {
      const table = s.rows.length
        ? `<table><thead><tr>${s.columns.map((c) => `<th${numeric(c) ? ' class="n"' : ""}>${esc(c.replace(/_/g, " "))}</th>`).join("")}</tr></thead><tbody>${s.rows.map((r) => `<tr>${s.columns.map((c) => `<td${numeric(c) ? ' class="n"' : ""}>${esc(show(r[c] ?? null))}</td>`).join("")}</tr>`).join("")}</tbody></table>`
        : "";
      const refusal = s.refusal ? `<div class="${s.refusal.code === "budget" ? "bad" : "note"}"><b>Not done:</b> ${esc(s.refusal.reason)} <b>Instead:</b> ${esc(s.refusal.instead)}</div>` : "";
      const read = s.queries ? `${s.queries} quer${s.queries === 1 ? "y" : "ies"}${s.bytes_scanned !== undefined ? `, ${esc((s.bytes_scanned / 1e9).toFixed(2))} GB read` : ""}` : "";
      return `<div class="card"><div class="row"><h3>Step ${s.n}</h3><span class="muted">${esc(s.asked)}</span></div>${s.says ? `<p>${esc(s.says)}</p>` : ""}${table}${s.rows_total > s.rows.length ? `<p class="muted">${s.rows_total} found; ${s.rows.length} shown.</p>` : ""}${s.notes.map((n) => `<div class="muted">${esc(n)}</div>`).join("")}${refusal}${read ? `<div class="muted">${read}</div>` : ""}</div>`;
    })
    .join("");
  const stopped = e.stopped ? `<div class="bad"><b>Stopped:</b> ${esc(e.stopped.detail)}</div>` : "";
  return `<p><a href="${esc(base + "explorations")}">&larr; All explorations</a></p>
<h1>${esc(e.question || "An exploration")}</h1><p class="lede muted">${esc(file)}</p>
<div class="banner"><b>Exploratory.</b> ${esc(EXPLORATORY_SAYS.replace(/^This answer is exploratory: it /, "This "))}</div>
${trust}${stopped}${steps}
<p class="muted">Used ${e.budget.steps} of ${e.budget.max_steps} steps and ${e.budget.rows} of ${e.budget.max_rows} rows.</p>`;
}

// --- results ---------------------------------------------------------------------------------------------

export interface ResultItem {
  file: string;
  at: string;
  metric: string;
  /** The period or dates it was about, as the person asked. */
  period: string;
  playbook: string;
  status: string;
  summary: string;
}

export function resultsBody(items: ResultItem[], base: string): string {
  if (items.length === 0) return `<h1>Results</h1><p class="lede">No question has been answered in this project yet. Each answer is kept here.</p>`;
  return `<h1>Results</h1><p class="lede">Every answer the analysis has given for this project, newest first. These are the facts behind what the assistant said.</p>
<table><thead><tr><th>When</th><th>What was asked</th><th>Outcome</th><th></th></tr></thead><tbody>${items
    .map((i) => `<tr><td>${when(i.at)}</td><td>${esc(i.metric.replace(/_/g, " "))}${i.period ? `, ${esc(i.period)}` : ""} <span class="muted">(${esc(i.playbook.replace(/_/g, " "))})</span></td><td>${badge(i.status)} ${esc(i.summary)}</td><td><a href="${esc(base + "results/" + encodeURIComponent(i.file))}">Open</a></td></tr>`)
    .join("")}</tbody></table>`;
}

type Format = "fraction" | "number";
const num = (v: number, f: Format) => (f === "fraction" ? `${(v * 100).toFixed(1)}%` : Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-GB") : String(Math.round(v * 100) / 100));
const delta = (v: number, f: Format) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${f === "fraction" ? `${Math.abs(v * 100).toFixed(1)} points` : num(Math.abs(v), f)}`;
const dn = (v: number | null, f: Format) => (v === null ? "unknown" : delta(v, f));
const where = (f: { dimension: string; value: string; scope?: Record<string, string> }) => `${f.dimension.replace(/_/g, " ")} = ${f.value}${f.scope && Object.keys(f.scope).length ? ` (inside ${Object.entries(f.scope).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")})` : ""}`;

function handoffBlock(h: Handoff): string {
  const hl = h.headline;
  const f: Format = hl?.format === "fraction" ? "fraction" : "number";
  return `<div class="card"><div class="row"><h3>${esc(h.metric.replace(/_/g, " "))}</h3>${badge(h.status)}${hl ? `<span class="muted">${esc(num(hl.value, f))} against ${esc(num(hl.baseline, f))}${hl.significant ? ", a real change" : ", within normal variation"}</span>` : ""}</div><div class="muted">${esc(h.reason)}</div>${
    h.findings.length ? `<ul>${h.findings.map((x) => `<li>${esc(where(x))}</li>`).join("")}</ul>` : ""
  }</div>`;
}

export function resultBody(r: Result, file: string, base: string): string {
  const hl = r.headline;
  const f: Format = hl?.format === "fraction" ? "fraction" : "number";
  const head = hl
    ? `<div class="card"><div class="row"><h3>${esc(hl.metric.replace(/_/g, " "))}</h3>${badge(r.status)}</div><div>${esc(num(hl.value, f))} against ${esc(num(hl.baseline, f))} expected: ${esc(delta(hl.change, f))}${hl.significant ? ", more than chance explains" : ", within what chance explains"}${hl.z != null ? ` <span class="muted">(z = ${esc(hl.z.toFixed(1))})</span>` : ""}</div></div>`
    : "";
  const stopped = r.status === "stopped" ? `<div class="bad"><b>Stopped: ${esc((r.stopped_reason ?? "").replace(/_/g, " "))}.</b> ${esc(r.stopped_detail ?? "")}</div>` : "";
  const findings = r.findings.length
    ? `<h2>Where it changed</h2><table><thead><tr><th>#</th><th>Where</th><th class="n">Change</th><th>Notes</th></tr></thead><tbody>${r.findings
        .map((x) => {
          const notes = [x.effect === "mix" ? "volume moved between groups" : "", x.role === "contributor" ? "carries an unusual part of the change, though no single place explains it" : "", x.persistence === "single_slot" ? "only part of the period" : "", x.after ? (x.after.status === "recovered" ? "has since gone back to normal" : "still off afterwards") : ""].filter(Boolean);
          return `<tr><td>${x.rank}</td><td>${esc(where(x))}</td><td class="n">${esc(delta(x.impact, f))}</td><td class="muted">${esc(notes.join("; "))}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : r.status === "complete"
      ? `<p class="muted">Nothing stood out as the place the change came from.</p>`
      : "";
  const contrib = r.contributions.length
    ? `<h2>Who contributed how much</h2><table><thead><tr><th>Where</th><th class="n">Contribution</th><th class="n">Share of the change</th><th>Against its usual</th></tr></thead><tbody>${r.contributions
        .map((c) => `<tr><td>${esc(c.level.replace(/_/g, " "))} = ${esc(c.node)}</td><td class="n">${esc(delta(c.contribution, f))}</td><td class="n">${c.share == null ? "" : esc(Math.round(c.share * 100) + "%")}</td><td>${esc(c.verdict)}${c.history ? ` <span class="muted">(usually ${esc(dn(c.history.typical, f))}, from ${esc(dn(c.history.low, f))} to ${esc(dn(c.history.high, f))})</span>` : ""}</td></tr>`)
        .join("")}</tbody></table>${r.explained ? `<p class="muted">The ${esc(r.explained.level.replace(/_/g, " "))} level accounts for ${esc(Math.round(r.explained.share * 100) + "%")} of the change.</p>` : ""}`
    : "";
  const hand = r.handoffs.length ? `<h2>The KPIs it depends on</h2>${r.handoffs.map(handoffBlock).join("")}` : "";
  const flagItem = (m: Result["masking_flags"][number]) => `<li>${esc(m.type.replace(/_/g, " "))} at ${esc(m.level.replace(/_/g, " "))}${m.node ? ` (${esc(m.node)})` : ""}${m.detail ? `: ${esc(m.detail)}` : ""}</li>`;
  const small = r.masking_flags.filter((m) => m.type === "small_cells");
  const big = r.masking_flags.filter((m) => m.type !== "small_cells");
  const flags =
    r.masking_flags.length > 0
      ? `<h2>Patterns that can hide a problem</h2>${big.length ? `<ul>${big.map(flagItem).join("")}</ul>` : '<p class="muted">None of the patterns that hide a problem were found.</p>'}${small.length ? `<details><summary>${small.length} place${small.length === 1 ? "" : "s"} had groups too small to judge (left out)</summary><ul>${small.map(flagItem).join("")}</ul></details>` : ""}`
      : "";
  const evidence = r.evidence.length ? `<h2>Supporting records</h2>${r.evidence.map((e) => `<div class="card"><b>${esc(e.source)}</b> about ${esc(Object.entries(e.about).map(([k, v]) => `${k} ${v}`).join(", ") || "the whole")}: ${e.skipped ? esc(e.skipped) : `${e.rows} record${e.rows === 1 ? "" : "s"} <span class="muted">(consistent with the finding, not proof of a cause)</span>`}</div>`).join("")}` : "";
  const trace = r.trace.length
    ? `<details><summary>How the steps went (${r.trace.length})</summary><table><thead><tr><th>Step</th><th>What it found</th><th>What happened next</th></tr></thead><tbody>${r.trace
        .map((t) => `<tr><td><code>${esc(t.step)}</code></td><td class="muted">${esc(Object.entries(t.facts).map(([k, v]) => `${k} ${v === null ? "-" : v}`).join(", "))}</td><td class="muted">${esc(t.rule ?? "went on to the next step")}${t.because ? ` (${esc(t.because)})` : ""}${t.notes.length ? ` ${esc(t.notes.join("; "))}` : ""}</td></tr>`)
        .join("")}</tbody></table></details>`
    : "";
  const cost = r.cost ? `<p class="muted">${esc(String(r.cost.queries))} queries, ${esc((r.cost.bytes_scanned / 1e9).toFixed(1))} GB read, about $${esc(r.cost.estimated_usd.toFixed(2))} at list price.</p>` : `<p class="muted">${r.steps.length} queries.</p>`;
  return `<p><a href="${esc(base + "results")}">&larr; All results</a></p>
<h1>${esc(r.playbook.replace(/_/g, " "))}</h1><p class="lede muted">${esc(file)}</p>
${stopped}${head}${findings}${contrib}${hand}${flags}${evidence}${trace}${cost}`;
}
