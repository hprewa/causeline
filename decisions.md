# Decisions

Technical decisions, with the reason, in the order they were made.

How this file is kept: one entry per decision, in the form **decision.** Why: reason. Work is grouped by sprint and step
(the steps are the rows of the table in `PROGRESS.md`); each step's entry names its commit and the section of its
evidence document, so a decision can be traced to the change and to the proof. A decision that is later reversed is not
edited away: a new entry says what changed and why.

- **The analysis never computes; the agent never decides what is true.** A deterministic runner does every
  number; the agent chooses what to run and explains. Why: answers must be checkable.
- **One file per concern.** `ontology.yaml` (words), `data.yaml` (all SQL), generated tools, playbooks (steps, no SQL),
  expert definitions, runner (maths). Why: a use case should be written without touching the core, and a person who
  does not code should be able to read each file.
- **Tools are generated from the ontology and data definition; the agent only calls them.** Why: no free-form SQL from
  the agent. A sidecar file (`tools.meta.yaml`) says what each tool answers, because Toolbox rejects unknown fields.
- **One slice contract for ratios and totals** (current and baseline numerator, denominator, squared term). Why: the
  runner's maths is shared.
- **Seasonality is part of the method, not an option.** Baselines compare like with like (same weekday, same hour,
  same calendar flags); a period with no comparable baseline is not judged; onboarding tests which cycles the data
  supports. Why: ignoring a repeating pattern produces false findings.
- **The core stays domain-free.** `npm run check:purity` fails if a domain word appears in `core/`, the skills or the
  shared playbooks. Why: the process must transfer to any use case.
- **Experts are explicit (verified or draft) or generic.** A draft says so in every answer. Verification happens only
  through a number the user matched and a past incident the analysis found. Saving again never verifies; changing a
  KPI's formula drops the status.
- **Routing is deterministic.** KPI by name and synonyms, task by keyword, period resolution, a scan strategy for
  vague questions. Fuzzy matching only for a KPI's own name or synonyms of six letters or more.
- **Supporting records are never findings.** Evidence from other tables is labelled "consistent with" and is looked up
  only for the culprit the drill found.
- **Masking checks:** offsetting children, time-slot masking, rate vs mix, small cells; a contrast test decides whether a
  large child is really worse than its siblings.
- **The Builder uses pure-npm SQLite (`sql.js`) for CSV files.** Why: nothing else for a non-coder to install. SQL it
  accepts is a single read-only SELECT.
- **Retired the first example pack from this repository** and kept the contact-centre pack as the worked example.
  Why: the public project is not tied to one domain; the lost trap-type coverage is listed in `PROGRESS.md`.
- **The starter pack (`packs/_template`) is validated by a test.** Why: it is the entry point for a new use case and
  must not rot.

## Sprint 1: BigQuery, standard parameters, intent-first questions

Evidence for every step is in `docs/evidence/sprint-1.md`; the plan is the table in `PROGRESS.md`.

### Step 1: BigQuery spike (commit f8534c6)
- **BigQuery is reached through Toolbox's own `bigquery` source and `bigquery-sql` tools, with named `@parameters`.** Why:
  no code of ours sits between the analysis and the warehouse, and the same generated-tool contract holds on both databases.
- **Sign-in is Application Default Credentials through gcloud for now.** Why: it works today; sign-in without gcloud is
  sprint 5 (easy setup).
- **The source must set `maxQueryResultRows`; `writeMode: blocked` must not be used.** Why: Toolbox returns 50 rows by default
  and says nothing about the rest; blocked write mode removes the `bigquery-sql` tools altogether. Both were found by the spike.

### Step 2: standard tool parameters (commit 6fd9fe0)
- **One slice tool per (KPI, split concept) with an optional filter for every other concept, and one series tool per KPI
  with the time level as a value.** Why: the tool count halved, a new filter needs no new tool, and a time level or filter is
  a value, never an identifier a caller could inject. A tool reference is written `name?aggregation=day`.

### Step 3: BigQuery dialect and targets (commit db337a8)
- **A dialect is a small interface (quoting, parameters, time buckets, cycle slots); a pack gets a second database by a
  `data.<target>.yaml` beside `data.yaml`.** Why: the vocabulary, playbooks, experts and evals are shared, so only the one
  file that already knows SQL differs.
- **Every generated statement is dry-run against BigQuery in a test.** Why: it checks syntax and types at no cost.

### Step 4: connector, parity and cost (commit 535d7a9)
- **The same eval cases must give identical findings on both databases (parity is the correctness test of a dialect).**
- **Each tool is dry-run once; a per-question byte budget (default 5 GB) stops a run before the query that would pass it,
  and the result reports bytes and an upper-bound dollar estimate.** Why: a warehouse bills by data read, so cost has to be
  visible and bounded before it is spent.

### Step 5: date-range windows (commit 5186dd9)
- **A range of whole days is compared with earlier windows of its own length, reusing the period logic unchanged; with a
  weekly cycle a range under a week is compared with the same weekdays.** Why: everything after the data check keeps one
  input type, and a Wednesday is not judged against the days before it. Sub-day ranges are not supported.

### Step 6: intent core (commit c408240)
- **The agent fills a fixed structure; deterministic code checks it and works out the dates.** Why: language is the agent's
  strength, dates and data are not; the same intent on the same data must give the same run.
- **A period is data (relative, to-date, since, calendar, range, label), never text. Periods never include today; weeks run
  Monday to Sunday.** Why: today is unfinished, and one fixed rule is easier to state and test than a configurable one.
- **Validation asks exactly one question, in a fixed order (KPI, task, period, comparison, view, filters), and never guesses a
  value: a near spelling is offered, not taken.** Why: a wrong guess runs the wrong analysis and looks right.
- **Data with a fixed end declares `as_of: data_end`; a "to date" span that starts before the data is cut and says so.**
  A named month, a range and "since a date" are never cut. Why: sample data would otherwise make "last week" empty.
- **`baseline` (a count of earlier windows) replaces the planned `baseline_rule`.** Why: there was only ever one rule.

### Step 7: running intent and surfaces (commit efc35ce)
- **The conversation's state lives in the MCP server for the life of the session: the intent so far, what was said since the
  last answer, and numbered answers.** Tools: `get_intent`, `set_intent`, `run_intent`, `recall`, `start_over`,
  `check_connection`. `route` and `scan_kpis` stay for vague questions. Why: a question is built over messages, and nothing
  runs until it is complete.
- **`run_intent` re-checks the intent and never runs an incomplete one; `set_intent` stores the ontology's name for the KPI.**
  Why: the model's slip cannot reach the data, and a change of KPI is recognised as a topic switch that says what carried over.
- **Filters become a `scope` the runner applies to every query (the tools already take each concept as an optional filter; a
  split by a scoped concept keeps only that value).** A tool that cannot be confined is an error, never a wider answer.
  Why: without it "just team 3" would be read back and then ignored.
- **A comparison runs on whole periods of the data (found by their days); anything else says so and runs nothing.** Why:
  the compare analysis takes period labels; widening it is later work and must not be faked.
- **`recall(n)` makes that answer the active intent again.** Why: "the same, for another value" is a refinement, not a new question.
- **A pack that reads BigQuery is metered in the server as well as in evals.** Why: a person's question must be bounded
  by the same budget as a test.

### Step 8: proof and docs (commit fbb6510)
- **The live tier is one prompt per conversation, and scenario messages must say what the user wants.** Why: a real message does
  not carry the fixture's hidden task, and an agent that asks is right; the first live BigQuery run missed twice for exactly this
  and the eval wording was corrected (recorded in the evidence, not hidden).
- **Test datasets in the cloud project are disposable.** Each eval recreates what it needs, so they are deleted after a sprint, not kept.
