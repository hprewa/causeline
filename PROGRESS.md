# Progress

Where the project stands and what comes next. Decisions and their reasons are in `decisions.md`; the proof for each step
is in `docs/evidence/`.

## How progress is tracked

- Work is planned as sprints of numbered steps. Each step ends in one commit that updates this file, `decisions.md` and the
  sprint's evidence document together, so `git log` reads as the step-by-step history.
- A step is `done` only when its checks ran and the evidence says what was **not** shown. Anything unfinished is listed
  under the step, not dropped.
- The tables below are the index: what exists, the step table of the current sprint, coverage debt, and what is next.

## What exists

| Area | State |
|---|---|
| Schemas and pack validation (ontology, data, playbook, result, eval cases) | done |
| Tool generator (ontology + data definition to Toolbox tools, with a metadata sidecar) | done |
| Runner: drill by place and time, rate vs mix, masking checks, like-for-like seasonality, product (driver) split, evidence from other tables | done |
| Router: KPI, task, period and expert from a plain question; scan of all KPIs for vague questions | done |
| Onboarding: data checks and seasonality analysis | done |
| Builder: CSV files to a checked pack by conversation, plain-sentence play-back, number reconciliation, expert verification | done |
| MCP server and Claude Code plugin; skills `causeline-investigate`, `causeline-onboard`, `causeline-build` | done |
| Eval harness with planted faults (runner level and agent level) and routing evals | done |
| Example pack: contact centre (synthetic data), on SQLite and on BigQuery with identical results | done |
| Standard tool parameters (one slice tool per KPI and concept with optional filters; one series tool with the time level as a value) | done |
| BigQuery: dialect, pack targets, dry-run checks, per-question cost budget | done |
| Date-range questions (whole days) | done |
| Intent: a fixed structure an agent fills in, natural periods resolved by code, one question at a time, plain-words play-back | done |
| Running intent: a question built over messages, scoped runs, recall, topic switches, connection check | done (live agent: 6/6 on BigQuery) |
| Starter pack for a new use case (`packs/_template`) | done |

Measured on the last run (SQLite unless stated): unit tests green in every package, contact-centre eval 18/18 (and 18/18 on
BigQuery, identical), routing 27/27, intent eval 16/16 (also on BigQuery), integration 6/6, core purity check OK.

## Sprint 2: step by step

Multi-point sign-off with a sign-off screen, the Builder on BigQuery, and the complaints showcase pack (evidence: `docs/evidence/sprint-2.md`).

| Step | What | State | Commit | Evidence |
|---|---|---|---|---|
| 1 | Spike and measure (cost of a deep dive on the public table, BigQuery dry-run behaviour) | done | 2d732db | Step 1 |
| 2 | Checks and status ladder core (draft, provisional, verified; stored regression numbers) | done | 982232c | Step 2 |
| 3 | Sign-off tools and the local sign-off screen | not started | | |
| 4 | Builder data layer and BigQuery (connect, profile, test, save) | not started | | |
| 5 | Skill rewrite and scripted end-to-end on both databases | not started | | |
| 6 | Complaints pack built by conversation, real incident evals | not started | | |
| 7 | Proof and docs | not started | | |

## Coverage debt

An earlier example pack (a different domain) was retired from this repository. The trap types it covered must be
re-covered by new packs before they count again:

| Trap type | Covered now | To re-cover with |
|---|---|---|
| Offsetting children | yes (`offset_sibling_teams`) | |
| Time-slot masking | yes (`time_block_wednesday_lunch`) | |
| Pure mix | yes (`pure_mix_rerouted_queue`) | |
| Simpson's paradox | yes (`simpson_every_queue_improved`) | |
| Data gap | yes (`missing_logs_site`) | |
| Seasonal pattern is not a finding | yes (`lunch_dip_is_not_a_finding`) | |
| Clean period | yes (`clean_week`) | |
| Cross-table cause (evidence chain) | no | alerts pack with a rule-change log |
| Decoy event that moved nothing | no | alerts pack |
| Two simultaneous causes | no | alerts pack |
| KPI tree hand-off (a KPI made of parts) | no | depth sprint |

## Sprint 1: step by step

| Step | What | State | Commit | Evidence (`docs/evidence/sprint-1.md`) |
|---|---|---|---|---|
| 1 | BigQuery spike | done | f8534c6 | Step 1 |
| 2 | Standard parameters on SQLite | done | 6fd9fe0 | Step 2 |
| 3 | BigQuery dialect and targets | done | db337a8 | Step 3 |
| 4 | Connector, parity and cost | done | 535d7a9 | Step 4 |
| 5 | Date-range windows | done | 5186dd9 | Step 5 |
| 6 | Intent core | done | c408240 | Step 6 |
| 7 | Running intent and surfaces | done | efc35ce | Step 7 |
| 8 | Proof and docs: live agent on BigQuery, setup guide | done | fbb6510 | Step 8 |

## Next

| # | Sprint | Done when |
|---|---|---|
| P0 | Privacy clean-up, rename, fresh repository, playbook audit (`docs/audit/playbook-language.md`) | done when this repository is pushed and verified from a fresh clone |
| 1 | BigQuery foundation, standard tool parameters, intent-first questions, running intent across messages (steps above) | the example pack runs on BigQuery; natural periods and follow-ups pass a new intent eval set. All eight steps done |
| 2 | Multi-point sign-off with a sign-off screen, Builder on BigQuery, the complaints showcase pack (the alerts example pack moves to sprint 3, where the depth upgrades need it) | a pack built by conversation reaches `verified` through the status ladder |
| 3 | Depth: branching playbooks, contributions vs history, KPI-tree hand-offs, interactions, recovery | branching playbooks with full branch coverage; new depth evals pass |
| 4 | Minimal Explorer with guardrails | out-of-catalogue questions answered, labelled and within budget |
| 5 | Easy setup, projects and sessions, companion view, demo | fresh machine to first answer with no terminal steps |
| 6 | Real non-coder test and fixes | one analyst, own question, timed, observed |
