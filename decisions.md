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

## Sprint 2: sign-off, Builder on BigQuery, complaints pack

Evidence for every step is in `docs/evidence/sprint-2.md`; the steps are in `PROGRESS.md`.

### Scope (set when the sprint was planned)
- **The sign-off screen is a local page served by the MCP server; confirm and flag write back to the project.** Why: a real screen to click, no install, and it works whatever the chat client can show.
- **The showcase is the complaints pack only; the alerts example pack moves to sprint 3.** Why: the depth upgrades that need planted alerts evals are sprint 3's.
- **Complaints evidence is the table's own fields; nothing is written to any cloud project.** Why: the demo stays read-only; enforcement-action tables can be added later.

### Step 1: spike and measure (commit 2d732db)
- **A pack declares its own query budget in `data.yaml` (`budget_gb`); the environment variable still overrides.** Why: a deep dive on the 2.3 GB public table reads 10 to 12 GB
  (about $0.06), which the default 5 GB would stop; the table's size is a fact about the pack, not about the machine.
- **The Builder will skip free-text columns when profiling BigQuery and filter columns before scanning.** Why: one narrative column costs more to profile than ten others together.

### Step 2: checks and the status ladder (commit 982232c)
- **A KPI's level (draft, provisional, verified) is always worked out from what is stored (`levelOf`), never set.** Why: a status that can be written by hand can be claimed; this one needs the
  automatic checks to pass and confirmed numbers of two different kinds with named sources, and it falls when any of that does.
- **The tools' number is hidden until the person has given theirs.** Why: a number shown with the question anchors the answer, and agreement then means less.
- **Confirming needs a match; flagging is always allowed; a flagged number blocks verified.** Why: confirming a mismatch would be signing off a number nobody believes.
- **A changed formula or fact SQL keeps the confirmed numbers on record but drops the KPI to provisional and its expert to draft, until `run_checks` re-works them.** Why: the numbers were true of the old
  meaning; restoring the status automatically when they still hold makes a safe edit cheap and an unsafe one visible.
- **Only checks that make a number wrong gate a KPI** (parents, time column, value ranges, parts adding up, days adding up, repeated rows); gaps, thin days and empty columns are notes. Why: a short or gappy
  history makes analysis weaker, not the numbers wrong, and would otherwise keep every small dataset from verifying.
- **`one_row_per` on a fact is optional; without it the repeated-rows check says "not checked", neither pass nor fail.** Why: the system cannot know what one row stands for, and a silent pass would be a false claim.
- **`reconcile_metric` stays as the one-number path and now yields provisional.** Why: existing flows keep working; a single number was never enough to call a KPI verified. Between steps 2 and 3 the
  Builder over MCP can therefore reach provisional only (recorded in the evidence).
- **A version 1 `build.json` is read as version 2 (a matched number becomes one confirmed total without dates, so `run_checks` asks for it again).** Why: workspaces started earlier keep working without hiding that their number cannot be re-worked.

### Step 3: sign-off tools and the screen (commit aeca125)
- **The screen and the chat tools call the same Builder functions; the screen can only suggest numbers, take a number, confirm or flag it, and re-run the stored checks.** Why: one code path means one set of rules; a screen that could edit the model would be a second, unreviewed way to change what is vouched for.
- **The page is served from the MCP process on 127.0.0.1, with a secret in the path, a Host and Origin check, JSON-only writes, a nonce CSP and no external resources.** Why: it needs no install and no account, and a web page from elsewhere must not be able to read or sign off anything.
- **`open_signoff` always returns the address as well as trying to open a browser.** Why: some clients and some machines cannot start one, and the user must never be stuck.
- **`confirm_number` takes `flag`, so a doubtful number can be recorded from chat too.** Why: a flag is part of the ladder's rules and should not need the screen.
- **`SqliteToolCaller` lives in `core/builder`, not in test code.** Why: tests of the checks and the screen then run the product's own generated statements, and a future offline check can use it.
- **The plugin bundle and skill are updated with the skill rewrite (step 5), not here.** Why: one rewrite of the instructions to the model, after the Builder is on both databases, rather than two.

### Step 4: the Builder on BigQuery (commit 80c48e7)
- **One `BuilderData` surface; the BigQuery implementation lives in `connect-bigquery`, which depends on the Builder, not the reverse.** Why: the Builder and its tests stay free of any cloud library, and a third database is one more implementation.
- **The dialect, the Toolbox source and `budget_gb` are written by `save_pack` from the connection, never by the agent.** Why: an agent guessing a source name or a limit would be a silent way to break the pack or the budget.
- **A statement is a read only if BigQuery's own dry run says SELECT; the textual guard is only the first check.** Why: text rules can be fooled, the database's own classification cannot.
- **`budget_gb` = 25 passes of what one fact scan reads from the dry run, at least 5 GB; the dry-run size, not what was billed.** Why: spike 1 measured a deep dive at 15 to 19 queries over the fact; BigQuery's cache can make a repeated statement read nothing, which once left the budget unset. On the complaints table this gives 19 GB (a deep dive expected at about 15 GB, about $0.08).
- **Profiling never reads free-text columns, and falls back to a sample (said so) when a pass would pass the budget.** Why: the narrative column alone cost more than all the others; a sample is an honest estimate, a refusal is a dead end.
- **A column that is almost a level is reported with the fix, not silently dropped or forced.** Why: on the real complaints table 19 of 76 sub-product names sit under several products; the single-parent rule is right, so the data has to say which sub-product it means.
- **`connect_bigquery` refuses a folder that holds the user's own files, and remembers the billing project in the folder.** Why: the two kinds of data must never mix, and the person should not have to set an environment variable for every session.
- **The fact test counts rows and returns the sample in one pass.** Why: a metered database bills each pass.

