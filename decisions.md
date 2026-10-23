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

### Step 5: skill rewrite and end-to-end (commit 74f2950)
- **The skill says the model never writes `source`, `dialect` or the cost limit, and `save_pack` fills `source` in for files as well.** Why: those are facts of the connection; every one the model must type is one it can get wrong.
- **The skill teaches "ask for their number first, show ours after" as a rule, and the tool enforces it by not returning ours with the questions.** Why: the instruction and the mechanism agree, so a model that forgets the instruction still cannot anchor the user.
- **Anything short of verified is called "unconfirmed numbers" in answers, and the investigate skill says so once.** Why: provisional is a real, useful state, and hiding it would be as wrong as overclaiming it.
- **The BigQuery end-to-end is a script you run, not part of the integration tests.** Why: it needs a signed-in account and a project and spends a few cents; the same path on SQLite is in the integration tests and shares every code path above the database.
- **The skill is tested for what it names and teaches, not for how an agent behaves.** Why: agent behaviour is measured by live runs (step 6), and a unit test cannot say anything true about it.

### Step 6: the complaints pack (commit a92f071)
- **The pack ends on 2023-02-12, not at the end of the table.** Why: compared with the CFPB's own counts, the copy is complete to 99.8-100% until the week of 6 February 2023 and then holds 92%, 68% and 32% of the newest weeks (and its timely flag reads 100% there). A pack must not answer from weeks it knows are part-filled; asking about them stops and says what the data covers.
- **Sign-off numbers come from the CFPB's published counts, fetched at run time, for weeks inside that window.** Why: it is a different system from the copy being checked, and the copy's own end is exactly the thing a sign-off against another system catches.
- **A seasonality cycle longer than 28 days is never recommended; it is reported and not applied.** Why: the like-for-like comparison needs an earlier day at the same position in every declared cycle, which no baseline of a few weeks holds for day of the month or month of the year, so every analysis stops.
- **The pack sets `coverage_ratio: 0.3` and nothing else.** Why: categories of 30 to 250 complaints a week lose half their usual rows in ordinary weeks; this is what pack-level thresholds are for. A threshold on a child's z-score was tried on weeks outside the cases and did not help, so it was not kept.
- **The Builder's budget is 40 passes of what one pass reads.** Why: a surge week drilled through two hierarchies took 30 queries; 25 passes stopped it.
- **Eval cases may say "among the findings" (`findings_include`), and an incident can ask for the same (`anywhere`).** Why: two findings can describe the same records (the company, and the channel nearly all of its complaints used); demanding that one be first tests the ranking, not whether the culprit is found. The default stays "first".
- **A quiet week is asserted as "the headline is within normal variation", not "no findings".** Why: on real data the analysis reports changes inside a week that cancel out, which is its job. This was changed after seeing results and is disclosed.
- **Wells Fargo and the Equifax mix case are out of the cases and in `known-gaps.md`, with what is expected and why.** Why: they are real, they fail, and a case file should say what works; the fix is analysis depth (sprint 3), not a threshold for this pack.
- **A user's own window and part of the data is a check of the kind its shape says (total, slice, grain).** Why: otherwise their numbers can never count as different angles and a KPI could never be verified from their reports.
- **The first level of the time hierarchy is the period questions are asked about; the skill says so.** Why: the live agent listed year, quarter and month above week, which would have made years the unit of analysis.
- **The MCP server carries instructions that name the skills.** Why: in the first live run the agent chose the developer path and showed the user YAML; the skill alone did not win the choice.

### Step 7: proof and the close of sprint 2 (commit 5088714)
- **A number far from the user's own for one KPI sets aside every other KPI's confirmed numbers for those days, until a number for them matches.** Why: in two live runs a rate was verified on days the counts showed to be short, because a rate can agree while the counts under it are wrong; one KPI's evidence about the data is evidence about all KPIs on it. Applies to whole-data numbers only (a mismatch for one product says little about the others), and from 10% apart.
- **A name on a user's own window is a label, not a different kind of check.** Why: in a live run every window the agent named became its own kind, so a KPI could never have two angles.
- **Suggested checks use the last settled period, and say so when the newest periods hold under 80% of the median of the eight before.** Why: the default suggestion was the part-filled week of a copy that stopped in March 2023. It is a note and a better default, not a gate: a real drop is not a reason to refuse a KPI.
- **The sprint is reported against its own five-point test, with two known gaps stated rather than dropped.** Why: the proof run succeeded after five rounds of fixes that each came from an earlier run, and two real incidents still fail; a sprint that says "done" without that would be a claim, not a result.
- **Run counts, not a pass rate.** Why: six runs with a model for a user are six samples; they show what can go wrong and that it can work, not how often.

## Sprint 3: analysis depth

Evidence for every step is in `docs/evidence/sprint-3.md`; the steps are in `PROGRESS.md`.

### Scope (set when the sprint was planned)
- **Analysis depth first; the branching playbook language moves to the next sprint.** Why: the real data exposed analysis gaps that matter now (two incidents missed, findings in noise, a guard that stops ordinary weeks); the language is a large piece on its own.
- **Proved with planted faults in the contact-centre generator plus the real complaints incidents; the alerts/AML pack stays out.** Why: planted faults are cheap and run on both databases, and the real incidents are the actual test; a second synthetic pack would double the sprint.

### Step 1: reproduce (commit 021e3d4)
- **An eval case can carry `gap: "<why>"`: reported as a known gap while it fails, and failing the run once it passes.** Why: a known failure must be visible without turning the suite red, and must not be forgotten when it is fixed (a marker left on a passing case is a lie in the other direction).
- **The real mix failure is a unit fixture plus the real data, not a planted-fault eval.** Why: the synthetic pack cannot produce it (no flat dimension of hundreds of values, and the agent hierarchy finds the shifted agent); the unit fixture reproduces the cause (thin baselines make the rate and mix split unstable) exactly.
- **Step 4 targets the cause found (an unstable split), not the symptom first thought of (no mix attribution).** Why: tracing the real case showed rate +0.129 and mix -0.095 against a change of +0.033, from nodes with three baseline rows; adding per-node mix tests on top of that split would have inherited the instability.
- **A note in `known-gaps.md` was wrong about the company's baseline and is corrected, not left.** Why: it said the company's rate "did not move"; its four-week baseline included one bad week.

### Step 2: contributions core (commit d667c0f)
- **Contributions are computed from the node's own series for the period and for eight earlier ones, not read off the drill's decompositions.** Why: the drill's splits are over the narrowed window and its baseline; history needs the same measure in every period, and a node's contribution to a whole is cheap to recompute from one day-level series.
- **A node is `unusual` only if it is outside everything seen before AND at least three robust standard deviations from the median; with under four earlier periods the verdict is `unknown`.** Why: with eight points a plain "outside the range" is wrong about one time in nine; the second condition keeps ordinary excursions `usual`. A guess would be worse than "unknown".
- **`new` means under min_volume rows a period in the baseline.** Why: a node that was not a regular part of the data has no history to be compared with.
- **The step adds no finding and changes none (a test compares the runs).** Why: attribution and the decision to report are separate changes; step 3 uses the verdicts, with its own gate.
- **Contributions are limited to splits over the whole window, at most five nodes, one query each.** Why: each node costs a query over the fact (about 0.6 GB on the complaints table); the biggest contributors are the ones a person needs.
- **A date range builds `baseline + 8` earlier windows (was twice the baseline).** Why: eight periods of history need them, they cost nothing (the day series is already read), and baseline selection is unchanged because it counts back from the period.
- **The Builder's budget is 50 passes of one pass's bytes.** Why: a deep dive with a surge is 15 to 35 queries, plus up to five for this step; 40 passes would have stopped the Equifax week at 28 GB.

### Step 3: contributors as findings (commit 617bb18)
- **A contributor is reported only in a concept that has no finding yet.** Why: the drill deliberately drafts only the deepest informative node of a hierarchy; adding its ancestors back as contributors would put a centre above its team in the ranking and bury the real finding.
- **It must carry a quarter of the change and 1.5 times its own size's share of it, and be `new` or `unusual`.** Why: a share alone reports the biggest node in any change; a rise spread evenly over every node is nobody's story, and a node that always contributes this much is context. Both are tested.
- **`role: contributor` is part of the finding.** Why: the reader (and the agent) must be able to tell "the drill followed this" from "this carries an unusual part of the change, though no single node explains it", and say so.
- **No contributors when the headline change is not significant.** Why: the reporting is for real changes; a quiet week must not gain findings from this step.
- **`contributor_share` is a pack-tunable threshold (default 0.25).** Why: like the other decision thresholds, how concentrated is "worth reporting" depends on the data.
- **The Wells Fargo case moved from the known gaps into the cases.** Why: it passes on the real data for the reason the sprint set out to fix; the planted gap case lost its marker the same way.

### Step 4: stabilise the rate/mix split (commit see `PROGRESS.md`)
- **A node with a baseline under `min_volume` rows takes the whole's baseline rate in the rate/mix split.** Why: its own baseline rate is a few outcomes (0% or 100% by chance); taking it at face value inflates both effects with opposite signs.
- **Contributions keep the node's real baseline rate.** Why: they must add up exactly to the change; only the explanation (rate versus mix) is stabilised.
- **The mix gate needs the mix total to point the same way as the change.** Why: an opposed mix is the other side of a rate effect, not what moved the whole.
- **The culprit is still the largest mix effect.** Why: once the thin nodes are stabilised the right node has it; choosing by contribution was not needed and would change other cases.
- **The Equifax timely-rate case moved from the known gaps into the cases.**

### Step 5: overdispersion and the data-quality guard (commit see `PROGRESS.md`)
- **Dispersion is estimated from the whole's own previous twelve periods and added to every child's variance; under five periods nothing is adjusted.** Why: the baseline fetched for the headline already shows how much the data moves by itself; with too few periods an estimate would be a guess.
- **The guard needs a shortfall of 4 standard deviations of the data's own variation, as well as under half the usual rows.** Why: one node in sixty falls under half by chance in data that varies; the flat rule stopped ordinary weeks.
- **The noisy-volume planted case lost its gap marker; the complaints quiet-week cases are not tightened.** Why: the first passes; the others could not be re-run on BigQuery (credentials expired).

### Step 6: the incomplete tail (commit see `PROGRESS.md`)
- **A period inside the newest under-80% stretch stops the run with `data_still_arriving`, a reason of its own.** Why: "data_quality" means a part of the data is thin; this means the whole newest stretch is, and the right next step differs (confirm with the data's owner, use the latest settled period).
- **The Builder's rule is shared, not copied.** Why: the sign-off and the analysis must agree on what counts as settled.
- **A real drop in the newest period is stopped too.** Why: it cannot be told from data arriving; stopping and asking is the safer error, and the message says so.

## Sprint 4: playbooks that branch

### Step 1: facts and trace (commit see `PROGRESS.md`)
- **Facts are published by the runner from what the step did, under a fixed list per compute step, not declared by each playbook.** Why: the playbook names no computation; the list is what conditions are checked against at load.
- **The trace records every step, not only drill moves.** Why: with branching, the route taken must be auditable; `path` stays as the drill detail.

### Step 2: the condition language (commit see `PROGRESS.md`)
- **Conditions are parsed by our own small parser, not by evaluating text.** Why: a playbook may come from a person; it must not be able to run code, and it must be checkable before any run.
- **A fact that was not published reads as null, not as an error.** Why: a step that was skipped publishes nothing, and a later rule has to be able to ask about it.
- **Conditions may read only facts from earlier steps (or the step's own, in `next`).** Why: a forward reference could never hold a value; loops are allowed only into a step with `max_visits`.
- **A `next` list must close with an `else`.** Why: every run must have somewhere to go; "no rule matched" is not an outcome.

### Step 3: branching (commit see `PROGRESS.md`)
- **A skipped step goes on to the following step; a step with `next` follows its rules.** Why: it keeps the four existing playbooks, which have neither, running exactly as before.
- **A rule's `stop` ends the run as stopped, so findings are not reported.** Why: a stop is for "this cannot be answered"; a branch that only wants to skip work uses `when` or a rule to a later step.
- **At most 40 steps and `max_visits` per step, default 1.** Why: a playbook can loop, so the runner bounds it and says which bound was hit.
- **`metric_change` does not stop early when the headline is quiet.** Why: offsetting siblings and masked time slots have a flat headline and must still be drilled; only the quiet-week noise is wrong, and step 5 of sprint 3 is where that is handled.

### Step 4: hand-off between KPIs (commit see `PROGRESS.md`)
- **The KPI tree lives in the ontology (`children`), the rule to use it in the core playbook.** Why: which KPIs depend on which is vocabulary; "look at the parts when nothing explains a real change" is generic.
- **A hand-off runs the same analysis for the part and keeps a short account, not the whole result.** Why: result.json stays readable; the part's own full run is one call away.
- **Chain limit of two KPIs deep, never back to a KPI above, at most three parts.** Why: a loop or a fan-out of full analyses is expensive and unreadable.
- **The step runs only when nothing explained a real change.** Why: when the data's splits do explain it, the parts are noise and cost.

### Step 5: branch coverage (commit see `PROGRESS.md`)
- **A branch is covered only by a passing case that is not a known gap.** Why: a failing case shows nothing about the branch.
- **The `verified` gate is a flag (`--require-branches`), not a default.** Why: the complaints expert is verified and cannot reach the hand-off branch without a KPI tree in its pack; making the gate default would break a honest label. It is reported either way.

### Step 6: recovery (commit see `PROGRESS.md`)
- **Recovery is judged on the periods after the one asked about, against the same baseline, and only the newest of them decides.** Why: a node that dipped back and forth is not recovered; the question a person has is "is it still a problem now".
- **Interactions moved to a later sprint.** Why: they need a search over pairs of nodes with its own multiplicity control; doing it with the time left would have been a guess.

### Close-out (commit see `PROGRESS.md`)
- **The branch-coverage gate is on by default; a branch the pack cannot reach is "not applicable".** Why: a default that fails an honest label (complaints) would be switched off by everyone; inventing a KPI tree to reach the branch would be a fiction. Supersedes the "opt-in flag" decision of sprint 4 step 5.
- **A live agent run is only meaningful on a freshly bundled plugin.** Why: the first run read stale results and looked like agent errors.
- **The skill tells the agent to round to nearest and not to subtract figures.** Why: two checks failed on numbers the agent had derived.

## The status ladder (commit see `PROGRESS.md`)
- **Four rungs: draft, reconciled, calibrated, verified; plus a flag "numbers not confirmed".** Why: the old `verified` meant only that two numbers matched; it never showed the analysis stays quiet in ordinary periods or finds real incidents. Each name is now a check that was run.
- **Reconciled needs three numbers from two periods and two kinds, each with a named source.** Why: two numbers from one week can agree by luck or by the same wrong date rule; a different period and angle catches week-start and join mistakes.
- **An expert stands exactly where its KPI stands.** Why: it must never be trusted more than the numbers under it; one record is easier to keep honest than two.
- **Old `verified` stands as reconciled until the KPI changes (`grandfathered`); old `provisional` is a draft.** Why: nothing a person had earned is silently thrown away, and nothing is promoted. This departs from the planning note on the flag: old provisional meant a matched number, not a plausible one.
- **The files carry a marker (`ladder: 2`, build version 3).** Why: the old and the new `verified` are the same word with different meanings.
- **Every change of rung is logged.** Why: answers state the rung, so the history of who and why must exist.
- **`verify_expert` stores the incident check and cannot make an expert verified alone.** Why: finding one incident without calibration proves nothing about false alarms.
- **The branch-coverage gate covers every expert above draft.** Why: a rung above draft claims the analysis was tested; untested playbook branches contradict it.
- **The shipped contact-centre experts are reconciled on synthetic data.** Why: totals are checked against totals recomputed from the files; there is no person's report, and the file says so.
- **A guard fails the build if the retired name returns.** Why: renames rot unless something checks them.

## Projects (commit see `PROGRESS.md`)
- **Projects live under one home folder with a registry; the person names them and never sees a path.** Why: Claude Desktop and Codex desktop have no useful working folder, and a user who opens a new session must find their work by name.
- **The server starts on the project it finds, and tools can switch it while it runs.** Why: one long-lived server process serves the whole conversation; restarting it to change project would lose the question being built.
- **Switching clears the question and restarts the data connection.** Why: both belong to the old project; carrying either over would answer about the wrong data.
- **`CAUSELINE_PACK` still pins a pack.** Why: engineers and the test suite rely on it; opening a project still works.
- **With no project the tools say so and how to create one, instead of guessing a folder.** Why: a random working folder (a desktop app's) must never become someone's project.
- **Opening a project re-runs the confirmed numbers, not the automatic checks.** Why: the numbers are what the person vouched for; the automatic checks are about the definition, which has not changed unless the person changed it. It keeps the cost of opening small.
- **A check that cannot run lowers nothing and says so.** Why: an expired sign-in is not evidence that the numbers moved; lowering the rung for it would punish the person for a connection problem.
- **One site, one secret: the new pages are served by the same local server as the sign-off screen.** Why: one link to give, one set of safety checks (secret in the address, this machine as Host and Origin) to keep right.
- **The read-only pages are built on the server with no script at all.** Why: a page that cannot run code and has nothing to press cannot be turned into an editor, and escaping on the server is the only escaping there is.
- **The sign-off page stays where it was and the menu links to the rest.** Why: its address is already in tests, docs and people's heads; moving it would break them for no gain.
- **A project not built here shows its experts' rungs as written and says its checks are not tracked.** Why: showing it as draft contradicts its experts, and showing it as reconciled without records would claim checks nobody can see.

## The Explorer (commit see `PROGRESS.md`)
- **A closed set of read operations, not a query tool.** Why: the Explorer is useful because it can answer a new question; it is safe because every operation is code with tests. A new operation is a code change, never a parameter.
- **Filter values are bound values; a value that matches nothing returns the values that exist.** Why: a guess would be a wrong answer with a fluent sentence; and a value that is only ever a bound parameter cannot be anything but a value.
- **Groups under the KPI's minimum volume are listed apart, not ranked.** Why: the same rule the analysis uses; a ranking led by a group of nine rows is noise.
- **Budgets are enforced in code and stay ended.** Why: a model asked to "keep it short" does not; the person must be told what was and was not read.
- **A refusal is a step in the record with a reason and an alternative.** Why: what was declined is part of the audit trail, and "no" with nothing to do next is not an answer.
- **One exploration at a time, continued by default, and written after every step.** Why: a question is explored in a few steps; the page must be able to show one under way, and a stopped conversation must not lose what was read.
- **A request that cannot be done is an answer with a reason, not an error.** Why: an error is something the assistant retries or hides; a refusal with an alternative is something it tells the person.
- **Values are rounded to six decimals in the answer.** Why: the answer is read by people and quoted by a model; the tests compare to that precision.
- **Routing to the Explorer is a hint, and only for a question an expert does not cover.** Why: a wrong route to an expert is caught by its checks; a wrong route to the Explorer would hide an expert's better answer. So a why question, a comparison and a trend are never taken.
- **"Worst" and "best" are read through the KPI's own direction.** Why: the worst service level is its lowest and the worst handle time is its highest; guessing one way would rank backwards half the time.
- **Explorations have their own list and are kept apart from results.** Why: a result is the analysis's checked output; an exploration is a different kind of thing with a different promise, and mixing them in one list would blur the label the person relies on.
- **The page says how far each KPI read is trusted, in words.** Why: an exploratory ranking of a draft KPI is two steps removed from a verified answer; the person should see that without knowing the ladder's names.
- **The shell hook is a guardrail and is called one.** Why: a pattern list cannot stop a determined command; saying it is a boundary would be a false promise. The real boundary is that no tool takes a query and the database role is read-only.
- **Words in quotes are not matched by the hook's command rules.** Why: a commit message that mentions a database must not be blocked; inline scripts, which live in quotes, have their own rule over the whole text.
- **The skill says a refusal is an answer, and says what to do with it.** Why: a model's habit on a refusal is to try the same thing another way; the skill names that and forbids it.
- **The `explore` tool is marked read-only.** Why: it reads fixed breakdowns and writes only its own record; leaving it unmarked made a non-interactive assistant ask for permission instead of answering.
- **Rankings return a `gap_to_next` column.** Why: the assistant kept wanting to say how far ahead the first was; giving it a computed number to quote is better than forbidding the sentence and catching the subtraction afterwards.
- **The SQL case no longer requires the word Builder.** Why: the assistant offered a breakdown of the same figure, which is a valid alternative; the case should check the refusal, not one wording of the way out.
- **Reported as it came out: 0/5, 3/5, 2/5, 5/5, 3/5.** Why: tuning wording until one run is clean and reporting that run would claim a reliability the assistant does not have.

## The analyst install path (commit see `PROGRESS.md`)
- **The data connection software is fetched on first use, not bundled.** Why: 156 to 316 MB a platform is too big to put in an extension or an installer, and a person who opens the extension should not wait for it.
- **Its SHA-256 is pinned in the code and checked before it is ever run.** Why: Google publishes no fingerprint, and a download that is run without a check is a way to run whatever is at that address; the table is the only trust we add.
- **No tool call waits for the download.** Why: a call that blocks for minutes is given up on by the client; the first use starts the download and says how far along it is, and the person asks again.
- **A bad or partial file is deleted, never run; a failed try is tried again.** Why: a half-installed program that is run is worse than a delay.
- **One definition of where the Causeline home is.** Why: projects and the fetched software must agree, from every client.
- **The first check of a new machine starts the download.** Why: the person asked "is it ready?"; saying no and doing nothing wastes the few minutes they would otherwise spend waiting; the line says how far along it is.
- **`check_setup` is marked read-only although it can start a download.** Why: its only effect is the cache of the software, which the next question would fetch anyway; asking permission for it in every client would put friction on the very first step.
- **A tool call that needs the data connection while it downloads is answered, not queued.** Why: the person is told in plain words and asks again; a held call would be given up on and the download's progress would be invisible.
- **The guidance is served by the server and embedded in its file; the skills stay the single source.** Why: Desktop and Codex cannot carry skills; copying the text by hand would drift; embedding it at build time makes the one file self-sufficient.
- **The handshake instructions repeat the rules that matter most, not only "call get_guide".** Why: a model that skips the guide still has to know not to write SQL, not to show paths and not to invent numbers.
- **Where the client has the skill, the skill wins.** Why: Claude Code loads skills by their descriptions and that works; the guide is the fallback, not a second voice.
- **The extension asks for a folder and an optional project, nothing else.** Why: a person should answer two questions at most; a credential has no place in a settings screen when Google's own sign-in exists.
- **The optional BigQuery project has an empty default.** Why: an optional value with no default may leave the variable unreplaced in the environment; an empty string fills it and the server treats empty as unset.
- **The icon is drawn by the build as a plain placeholder.** Why: the build must need nothing else; a real icon is a design task and is listed as not done.


### Install path step 5: the single executable and the Codex installer
- **One program for Codex, built as a Node single-executable; the same file serves, installs and guards.** Why: Codex provides no Node; one file with a few commands is the least to download and the installer can point at itself.
- **The installer edits only marked blocks, copies each file aside first, is idempotent, and refuses what it cannot do safely.** Why: the settings are the person's; uninstall must return their bytes exactly.
- **The hook runs the program's own `guard`.** Why: the same rules as Claude Code from one source, and no Node needed.
- **The embedded playbooks are written to the Causeline folder at start.** Why: the server reads playbooks from disk; one extraction is simpler than a second code path.
- **The release workflow is written but not run.** Why: it cannot be run from here; saying so beats pretending the other platforms are built.

### Install path step 6: guide and proof
- **The guide admits the Codex installer is a command, run from the Run box, and says what has not been tried.** Why: no terminal is true only for Claude Desktop; saying otherwise would send people into a dead end.
- **The live run's 2/3 is reported as it came.** Why: the miss is the known derived-number weakness; a rerun until it passed would hide it.

### Guided setup step 1: the prep card
- **The card is its own file (`setup.json`), not part of `build.json`.** Why: it must exist before anything is connected, and it needs no new state version or migration.
- **The card's numbers are the person's figures, not checks.** Why: the ladder counts only numbers confirmed at sign-off against a named source; the card saves asking twice, it does not lower the bar.
- **A card holds three numbers; a fourth is refused.** Why: three is what the first rung asks for; more can come at sign-off.
- **Progress is "N of M setup steps done" in the build status.** Why: a person returning in another client needs one line, not a checklist.

### Guided setup step 2: cost caps
- **The person's limit beats any drafted one and survives a re-save.** Why: a number they chose must not be quietly replaced by a guess from the data size.
- **Looking at big data asks first, from table metadata, and reads nothing until told.** Why: the estimate is free and exact enough; a surprise bill on the first step is what ends trust.
- **The worst case shown is the smaller of the tables' total and the setup budget.** Why: big tables are sampled, so the table size alone would scare people off for no reason.
- **Money is list price with the free terabyte ignored.** Why: an upper figure is safe to say; the free tier depends on the account.

### Guided setup step 3: access
- **Two roles are named, split by what fails.** Why: a refusal to run queries and a refusal to read are fixed on different resources; asking for one broad role would be both riskier and wrong.
- **The message never mentions scopes.** Why: read-only comes from the role; naming scopes invites an administrator to approve something broader.
- **The analyst sign-in without a terminal is documented, not built.** Why: it needs a real Google Cloud console to build and prove; claiming it would be a fiction.

### Guided setup step 4: discovery from a KPI
- **Two calls: shortlist for free, then look at only what the person confirmed.** Why: reading a whole dataset to find three tables is the cost and the noise this is meant to avoid; the person knows which tables are theirs.
- **Plain word matching, no model call in the tool.** Why: it can be explained to the person ("its name has complaint"), tested exactly, and costs nothing.
- **Related tables are offered, not picked.** Why: a lookup of places or products is often needed but never matches the KPI's words; silently adding it would hide a join.
- **Risks are questions, not fixes.** Why: whether test rows should count or a number is a percent is the person's call; the tool only notices.

### Guided setup step 5: proof
- **`check_connection` works on a project still being set up and reads `project.dataset`.** Why: the real run showed it failing exactly when a person needs it, and for any data held in another project.
- **The proof is scripted, and the missing live run is said.** Why: a script plays the model deterministically and shows the tools; it cannot show that the guide makes an assistant use them well.

### Guided setup: the two faults from the second live run
- **The reminder rides on tool results, not only on the guide.** Why: the guide already said to ask the incident question and not to state derived numbers, and the live assistant did both anyway; a sentence in the result it is reading at that moment is harder to skip.
- **`accept_sample` says what its figure covers.** Why: a bare total invites division; the tool knows the period, the assistant should not have to guess a per-day rate.

### Phase 1 close-out step 1: the engineer path
- **Clone, install, `init`; not `npx github:`.** Why: npm cannot build this workspace repository as a git dependency (the `prepare` build fails in its temporary clone), and a dependency-free launcher would be a second product to keep in step.
- **`init` copies the server to the Causeline home and points the client at the copy.** Why: an npx or clone folder can move or be cleaned; Codex's settings must not break when it does.
- **Claude Code is set up with its own plugin commands.** Why: the settings format is Claude Code's to change; its commands are the stable surface.
- **Cost control is loaded by the eval package at run time.** Why: three packages formed a build cycle that a clean checkout could not resolve; the cost is one untyped-looking import with its type written beside it.

### Phase 1 close-out step 2: sign-in without a terminal
- **Causeline keeps its own sign-in and never touches `gcloud`'s.** Why: changing the person's other tools' sign-in is not Causeline's business, and a second sign-in is easy to remove.
- **The server points Google's libraries at it only when nothing else is set.** Why: an engineer who set `GOOGLE_APPLICATION_CREDENTIALS` on purpose must keep what they chose.
- **`sign_in` returns at once and `check_connection` is the confirmation.** Why: a tool call that waits for a person in a browser would time out in most clients; the person says when they are done and the check is the evidence.
- **Scope is `bigquery`, not `cloud-platform` or a read-only variant.** Why: BigQuery has no read-only scope that works for queries; read-only comes from the person's roles, and the guide says so.
- **The sign-in file's secret is not treated as a secret.** Why: Google documents a desktop client's secret as non-confidential; the rule that Causeline never accepts a password, key or token is about the person's own credentials, which still never reach it.

### Phase 1 close-out step 3: Codex
- **A throw-away Codex home per run.** Why: the person's own Codex settings and sign-in must not change, and a stale or wrong model in their settings must not decide a test.
- **Approval of Causeline's tools is set for the test harness only.** Why: turning approvals off is the person's security choice; the installer does not make it.
- **An agent that could not run is an error, not a fail.** Why: a usage limit says nothing about the product; the table shows it and the evidence says no rate exists.

### Phase 1 close-out: the shared sign-in app is a task after development
- **Recorded as an open item in PROGRESS.md, to do before analysts use Causeline as intended.** Why: the administrator's sign-in file works for teams with someone to make it, but not for a lone analyst, and the product's promise is no terminal and no help. It waits because it needs a domain and privacy policy that do not exist yet and a Google review whose wording depends on the finished product.
