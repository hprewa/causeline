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
| Sign-off ladder: draft, provisional, verified from automatic checks and the user's numbers from different angles with named sources; suspect windows; re-run after a change | done |
| Sign-off screen (a local page served by the MCP server) | done (not yet used by a person) |
| Builder on BigQuery: connect, metered profile, test and save, per-pack budget | done |
| Example pack: complaints (the CFPB's public table), built by conversation, signed off against the CFPB's published counts | done (all 7 real-incident cases pass on BigQuery) |
| Contributions judged against history (new / unusual / usual), explained share, contributors when no single node dominates, stable rate and mix split, overdispersion-aware tests, incomplete-tail stop | done (sprint 3) |
| Playbooks that branch: named facts, safe conditions, `when` / `next` / bounded loops, a full trace, branch coverage in the eval | done (sprint 4) |
| Hand-off to the KPIs a changed KPI depends on; recovery of a culprit in later periods | done (sprint 4, planted data only) |

Measured on the last run (SQLite unless stated): unit tests green in every package, contact-centre eval 25/25 (it was 18/18 identical on
BigQuery before sprint 3; parity since is not re-measured), routing 27/27, intent eval 16/16, integration 7/7, core purity check OK;
complaints eval on BigQuery 7/7.

## Sprint 2: step by step

Multi-point sign-off with a sign-off screen, the Builder on BigQuery, and the complaints showcase pack (evidence: `docs/evidence/sprint-2.md`).

| Step | What | State | Commit | Evidence |
|---|---|---|---|---|
| 1 | Spike and measure (cost of a deep dive on the public table, BigQuery dry-run behaviour) | done | 2d732db | Step 1 |
| 2 | Checks and status ladder core (draft, provisional, verified; stored regression numbers) | done | 982232c | Step 2 |
| 3 | Sign-off tools and the local sign-off screen | done | aeca125 | Step 3 |
| 4 | Builder data layer and BigQuery (connect, profile, test, save) | done | 80c48e7 | Step 4 |
| 5 | Skill rewrite and scripted end-to-end on both databases | done | 74f2950 | Step 5 |
| 6 | Complaints pack built by conversation, real incident evals | done | a92f071 | Step 6 |
| 7 | Proof and docs: live agent from an empty folder to verified KPIs and an investigated question | done | 5088714 | Step 7 |

## Sprint 3: step by step

Analysis depth: contributions judged against history, and the two real incidents the analysis misses (evidence: `docs/evidence/sprint-3.md`).

| Step | What | State | Commit | Evidence |
|---|---|---|---|---|
| 1 | Reproduce: planted faults, a `gap` marker for cases expected to fail today, a unit fixture for the real mix failure | done | 021e3d4 | Step 1 |
| 2 | Contributions core (rate and mix effect, share, explained share, history, verdict) with no change to findings | done | d667c0f | Step 2 |
| 3 | Report contributors when none dominates | done | 617bb18 | Step 3 |
| 4 | Stabilise the rate and mix split for thin baselines; mix gate direction; culprit by contribution | done | see `git log` (message starts "Sprint 3 step 4") | Step 4 |
| 5 | Overdispersion-aware tests and the data-quality guard | done | see `git log` (message starts "Sprint 3 step 5") | Step 5 |
| 6 | Incomplete tail of the data | done | see `git log` (message starts "Sprint 3 step 6") | Step 6 |
| 7 | Proof and docs | partly done | complaints eval 7/7 on BigQuery; the rest is parked (below) | Step 7 |

## Sprint 4: step by step

Playbooks that branch, and hand-offs between KPIs (design: `docs/audit/playbook-language.md`; evidence: `docs/evidence/sprint-4.md`).

| Step | What | State | Commit | Evidence |
|---|---|---|---|---|
| 1 | Fact registry and a full trace (no behaviour change) | done | see `git log` (message starts "Sprint 4 step 1") | Step 1 |
| 2 | Safe condition language and load-time validation | done | see `git log` (message starts "Sprint 4 step 2") | Step 2 |
| 3 | Branching: `next` rules, `when`, bounds and a step budget | done | see `git log` (message starts "Sprint 4 step 3") | Step 3 |
| 4 | Hand-off from one KPI's playbook to another (a KPI made of parts) | done | see `git log` (message starts "Sprint 4 step 4") | Step 4 |
| 5 | Branch coverage in the eval report, and the `verified` gate | done | see `git log` (message starts "Sprint 4 step 5") | Step 5 |
| 6 | Recovery (a change that has since reversed); interactions between findings moved to a later sprint | done | see `git log` (message starts "Sprint 4 step 6") | Step 6 |

## Status ladder migration

New ladder (draft, reconciled, calibrated, verified; flag "numbers not confirmed"), migrated through the schema, Builder, router, intent run, MCP tools, sign-off screen, evals, packs, skills and docs (`docs/evidence/ladder.md`).

| Part | State |
|---|---|
| Shared definitions, reading of old expert and build files, status log | done |
| Builder rule (three numbers, two periods, two kinds), experts follow their KPI, `accept_sample` | done |
| Router, intent run, MCP tool texts, sign-off screen, branch gate, shipped experts, skills, README, guard in CI | done |
| Unit tests in every package | pass |
| Contact-centre 25/25, routing 27/27, intents 16/16, scripted end-to-end tests 7/7 after the change | pass; complaints eval on BigQuery 7/7 |
| Calibration and fault injection (the two rungs above reconciled) | not started: phase 2 |

## Analyst install path

One download to a first answer on Claude Desktop, Codex and Claude Code: no terminal, no Node, no manual download (`docs/evidence/install.md`).

| Step | What | State |
|---|---|---|
| 1 | The data connection software fetched on first use: pinned fingerprints, resume, check, background progress | done |
| 2 | Wired into the server, `check_setup`, a real download through the server | done |
| 3 | The guidance (skills) delivered through the server: `get_guide` | done |
| 4 | A `.mcpb` file for Claude Desktop | done (not installed in a real Claude Desktop) |
| 5 | A single executable and a Codex installer | done on Windows (run with no Node; Codex app, macOS and Linux not run) |
| 6 | The analyst guide, live run, regression | done (live agent 2/3; BigQuery complaints not re-run; no real Desktop/Codex/macOS) |

## Guided setup on the analyst's own data (Phase 1b)

Plan: prep card and resume, cost caps in plain words, admin message and sign-in, KPI-scoped discovery, proof (`docs/evidence/setup-guided.md`).

| Step | What | State |
|---|---|---|
| 1 | The prep card and resumable setup | done |
| 2 | Cost caps in plain words | done (run on real BigQuery; the limit is offered on connecting) |
| 3 | The message to your admin; clearer sign-in | done (analyst OAuth client not built) |
| 4 | KPI-scoped discovery | done (run on real BigQuery, including a live assistant on a seven-table dataset) |
| 5 | Proof on BigQuery and regression | done (scripted proof passed; two live Claude Code runs, one run each; skipped incident question and a derived per-day figure addressed afterwards, not re-run live) |

## Phase 1 close-out

Sign-in without a terminal, the engineer path, Codex run for real, a tester kit (`docs/evidence/phase-1-close-out.md`).

| Step | What | State |
|---|---|---|
| 1 | The engineer path: `causeline init` for Codex, Claude Code, Claude Desktop (not `npx github:`, which npm cannot build); a clean-checkout build fault fixed | done |
| 2 | Analyst sign-in without a terminal (user-created OAuth client) | done: tested against a fake Google and once against real Google (one account; Toolbox use of it not run) |
| 3 | Codex run for real | two setup conversations done (one run each); question evals through Codex not scored: the account's usage limit was reached |
| 4 | Tester kit, install guide, regression | done: kit written and regression green (runner-level 25/25, 38/38, 16/16, 8/8, complaints on BigQuery 7/7); the trial with a real person is not done |

## Phase 2: trust

Calibration, held-out incidents, fault injection on the person's own data, confidence labels, an alerts pack (`docs/evidence/calibration.md`; plan in the Phase 2 section of the plan file).

| Step | What | State |
|---|---|---|
| 0 | What counts as an alarm, measured on two packs | done |
| 0b | The analysis allows for the data's own movement; claims inside a flat whole held to a higher standard | done (existing checks unchanged: 25/25, 38/38, 16/16, 8/8, complaints 7/7; complaints replay still mixed with real events) |
| 1 | Calibration core and tools | done (unit tests and one real run on contact-centre data through the server; BigQuery, the hit rate and a live assistant not shown) |
| 2 | Held-out incidents and incident import | done (mechanics shown on SQLite and by stub; no live assistant, no BigQuery) |
| 3 | Fault injection on the person's own data (files / SQLite) | done (clear faults, one synthetic dataset, no cloud data, no live assistant) |
| 4 | Confidence labels on answers | done (a rule from the run and the rung; not compared with how often high answers are right; no live assistant) |
| 5 | Proof on two packs, rates published | not started |
| 6 | Synthetic alerts pack | not started |

## Projects and the companion page

One folder per project under a home folder, a registry, and read-only localhost pages next to the sign-off screen (`docs/evidence/projects.md`).

| Step | What | State |
|---|---|---|
| 1 | Registry in the home folder; `list_projects`, `create_project`, `open_project`, `project_summary`; the server finds its project; switching restarts the data connection and clears the question | done |
| 2 | Drift check on opening a project (stored numbers re-run quietly; a difference lowers the rung and is said first) | done |
| 3 | One local site with pages: overview, sign-off (the only page with buttons), how the steps decide, results; `open_project_page` | done |
| 4 | Skills, README, plugin settings: the project flow instead of an environment variable | done |

## The Explorer

Questions no expert covers, answered from a closed set of fixed read operations, labelled exploratory, with a record and a page for each (`docs/evidence/explorer.md`).

| Step | What | State |
|---|---|---|
| 1 | The operations, refusals, budgets and the stored record (`core/runner/src/explore.ts`) | done |
| 2 | The `explore` tool over MCP, the stored exploration, real data (SQLite and Toolbox) | done |
| 3 | Routing: ranking, top-N and breakdown questions go to the Explorer; look-alikes do not | done |
| 4 | The page: explorations list and detail, next to results | done |
| 5 | The skill, a guardrail hook for Claude Code, README | done |
| 6 | Proof: SQLite and BigQuery parity, a live assistant on five questions | done: parity identical (38 rows, 0.06 GB); live assistant 5/5 once and 3/5 on a repeat (it sometimes states a number it worked out); full regression green |

## Parked from sprint 3 (not done, by decision)

| Item | Why it matters |
|---|---|
| SQLite against BigQuery parity and cost per contact-centre case after the depth changes | shows the depth steps behave the same on both databases |
| Live agent answering both incident weeks with the contributions table | shows the skill reads the table well |
| Why the Wells Fargo case grew from 25 to 43 queries | cost per question |
| Quiet-week complaints cases still report 1 to 3 findings with a non-significant headline | they cannot be tightened to "no findings" yet |
| Time-bucket z-scores and `standsOut` not dispersion-adjusted; Benjamini-Hochberg deferred | possible source of the quiet-week findings |

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

The sprint list that followed sprint 4 (Explorer, easy setup, a non-coder test) is replaced by a phased plan built around one aim:
from raw tables to a verified "why did this change?" expert in an afternoon, and it stays correct. **Proposed, awaiting approval**;
nothing below is started. Existing features all stay.

| Phase | Theme | Done when |
|---|---|---|
| Close-out | Done except BigQuery parity (`docs/evidence/close-out.md`): live agent reads the new result fields (2/2 after a fix); the 43-query case traced (a flat-parent test disagrees with the headline; goes to calibration); branch coverage is the default gate | parity and cost on BigQuery re-run when the machine has room |
| 1a | Access spikes done, report only (`docs/evidence/phase-1-spikes.md`): own OAuth client as the analyst sign-in, a Claude Desktop extension with Toolbox fetched on first run, Codex needs a self-contained server executable | go / no-go per item recorded |
| 1 | Easy, safe access: spikes first (sign-in verification, a no-install analyst path, a second AI client), then analyst install, discovery scoped to one KPI, read-only sign-in with a message for an admin, cost caps, a prep card, resumable setup, an engineer install path, a second client | a non-coder reaches a `draft` pack on their own BigQuery data from a fresh machine |
| 2 | Trust: a longer status ladder (draft, reconciled, calibrated, verified) with migration; multi-point reconciliation; calibration (false-alarm and hit rates, with a default of one false alarm in twenty quiet periods); held-out incidents; fault injection on a user's own data; confidence labels; a synthetic alerts pack with planted truth | one pack reaches `verified` through the full ladder; false-alarm and hit rates published for two packs |
| 2b | Open benchmark with faults not tuned for, run on more than one model | results table and write-up published |
| 3 | Design partners (3 to 5), support bundle, guided fixes | partners reach `verified` on their own data; time to verified measured |
| 4 | Scale setup and routine: semantic-layer import, incident import, monitoring, report formats | one partner team uses it weekly unprompted |
| 5 | Remaining depth: interactions and combination search, peer comparison, lagged effects, numeric drivers, level-shift baselines, parallel branches, decision steps, non-additive metrics, an explorer | two-cause and decoy-event evals pass |
| 6 | Stay correct: drift detection, feedback to eval cases, run log, case studies | status drops correctly on drift |

**Open item, after development (needed before real analysts use it as intended): a Causeline-owned Google sign-in app, verified by Google.** Today every organisation's administrator makes a "desktop app" sign-in file once and gives it to the team (`docs/guides/analyst-sign-in.md`). A person with no administrator and no Google Cloud console cannot sign in without a terminal. Fix: publish one Causeline sign-in app so nobody needs to make a file. Needs a verified domain, a public home page and privacy policy on it, a recorded demo of the grant flow, and a written reason for the BigQuery scope; Google's review typically takes 3 to 5 business days (`docs/evidence/phase-1-spikes.md`). Until it is done, an app left in Testing mode is limited to 100 listed test users who must sign in again every 7 days. Also decide the scope question again then: the review asks why access is wider than read-only, and read-only comes from the person's role, not the scope.

Parked: the Explorer (not needed for the first usable version).
