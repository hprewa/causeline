# Causeline: the build guide for Claude Code

Nov 13, 2026 · @Harsh

## Read this first

The goal is one sentence: make Causeline the tool a model-risk or compliance team would sign off, and prove it with published numbers.

Repo: `github.com/hprewa/causeline`. This guide is written for Claude Code to execute, phase by phase, with the owner approving each phase.

### Positioning (do not drift from this)

- Causeline is **the controls layer that makes AI analytics auditable**. It is not sold on speed.
- The drill maths is a commodity. BigQuery, Snowflake and Databricks all ship a key-drivers function. Causeline wins on trust: numbers reconciled to the user's own reports, a measured false-alarm rate, an evidence trail, and an LLM that never computes.
- Target reader: analytics, risk and compliance teams in regulated firms (banks, insurers, payments).
- It stays what the README says: not a fraud or financial-crime detection system. It explains movements in reported numbers.

### Working rules for Claude Code

1. **Keep the repo's own convention.** One step ends in one commit that updates `PROGRESS.md`, `decisions.md` and the evidence file for that phase. Every evidence entry ends with a "Not shown" paragraph.
2. **Test first.** For every defect in this guide, add the failing case before touching the fix. Mark it with the existing `gap` marker until it passes.
3. **Never tune to a test.** Do not change a threshold, a KPI definition or an eval expectation only to make a case pass. If a threshold changes, re-run every eval and report all rates before and after.
4. **No new features outside this guide.** If something looks useful and is not listed, write it under "Parked" in `PROGRESS.md` and move on.
5. **Run things more than once.** Any result that involves a live LLM is reported as a rate over at least 10 runs, never a single pass.
6. **Keep the core domain-free.** `npm run check:purity` and `npm run check:ladder` must pass on every commit.
7. **Stop and ask the owner** before: changing the ladder's meaning, adding a dependency, changing a default significance level, or publishing anything.
8. **Full regression before closing a phase:** `npm test`, `npm run eval`, routing eval, intent eval, integration tests, and the new noise suite from Phase 0.
9. **Plain words in everything a user reads.** Tool texts, skills and pages keep the repo's existing plain-language style.

### How to use this guide

Work the phases in order. Phases 0 to 2 are the gate: nothing after them matters until quiet weeks stay quiet and the number rule is enforced in code. Each phase lists the problem, the tasks, and the acceptance test.

## Baseline: what was tested in November 2026

The engine is sound on clean data and fails when the parts of a KPI wobble from week to week. These results come from an independent run on commit `16b198c`, with Toolbox v1.14.0 and SQLite. No live LLM and no BigQuery were available in that run.

### What passed

| Check | Result |
| --- | --- |
| Unit tests | 557 pass, 0 fail |
| Shipped eval, contact-centre | 25 of 25 |
| 12 unseen planted faults (new seeds, teams, combinations) | 11 found |
| Quiet weeks, clean data, 8 seeds | 0 false alarms |
| Quiet weeks, noisy volume, 6 seeds | 0 false alarms |
| Builder on a new domain (deliveries, 96,000 rows) | Built, reconciled, planted week found |
| Hostile input to router and Explorer | Refused, nothing ran |

### What failed

| # | Defect | Evidence | Reproduce |
| --- | --- | --- | --- |
| D1 | False alarms when rates wobble | 5 of 6 quiet weeks raised a finding | `--seed 21..26 --fault noisy_rate:0.02:team`, `service_level`, `2026-W06` |
| D2 | Planted faults not found on noisy data | `inject_faults` found 1 of 3 on the delivery data; a 4-point drop in one warehouse was missed | Delivery dataset below, `inject_faults` with `seed: 5` |
| D3 | No cross-dimension finding | Fault was carrier X at warehouse Y only; reported as two separate findings whose shares sum to over 200% | Delivery dataset, `metric_change`, `2026-W31` |
| D4 | Small-unit miss | One agent dropping 15% for a week: no finding | `--seed 202 --fault bad_week:agent_023:wk6:0.15` |
| D5 | Number rule is only a prompt | Repo's own evidence: live assistant stated a number it worked out in 2 of 5 Explorer runs | `docs/evidence/explorer.md`, step 6 |
| D6 | Router is keyword-only | "are calls taking longer than usual?" routed to call volume, not handle time; typos and paraphrases fall to the Explorer; filters and dates dropped | `causeline route "<question>"` |
| D7 | Calibration cannot finish on short history | 12 weeks of data, one week labelled real, 7 quiet weeks left, 8 needed | Delivery dataset, `calibrate` then `label_period` |
| D8 | Sign-off loophole | A total for a week, a slice of the same week and one day inside it counted as "two periods" | Delivery dataset, `propose_checks` then three `confirm_number` calls |
| D9 | Stale and inconsistent texts | Build guide says calibration is "not built yet"; Explorer reports `queries: 0` after a query; router calls an expert "draft" while its KPI is reconciled; README status section is behind `PROGRESS.md` | See Phase 5 |

### The delivery dataset (add it to the repo as a test fixture)

A generator script produces `orders.csv`: 12 weeks from Monday 1 June 2026, 8,000 orders a week, columns `order_id, shipped_at, warehouse, carrier, region, delivered_on_time, delivery_hours, order_value`.

- Four warehouses with base on-time rates of 0.92, 0.90, 0.88 and 0.91. Three carriers with offsets 0, -0.02 and +0.01. Five regions.
- Each warehouse's rate wobbles each week by a normal draw with standard deviation 0.012.
- Planted fault: in week 10 (3 to 9 August, label `2026-W31`), one carrier at one warehouse loses 0.30.
- KPIs: `on_time_rate` (ratio, numerator `delivered_on_time`) and `orders_shipped` (sum, value `1`). Dimensions: warehouse, carrier, region. Time levels: week, day. No seasonality.

The known truth for that cell in that week is about 60% on time against about 90% elsewhere.

## Phase 0: make every failure a test

Before any fix, every defect in the baseline becomes a case that fails today and is tracked. This is the safety net for everything after.

### Tasks

1. **Noise suite.** Add a new eval file `packs/contact-centre/evals/noise.yaml` with quiet-week cases that carry `noisy_rate:0.02:team` and `noisy_rate:0.02:queue`, at least 20 seeds each, across `service_level` and `aht`. Expectation: `no_findings: true`. Mark as `gap`.
2. **Noise plus a real fault.** Add cases where `noisy_rate` runs alongside a planted fault (`understaffed`, `block_outage`, `long_calls`). The fault must still be found. This stops the fix for D1 from going deaf.
3. **A rate reporter.** Extend `scripts/rates.mjs` (or add `scripts/noise-rates.mjs`) to print one table: false-alarm rate with a 95% interval per noise level (0, 0.01, 0.02, 0.03), and detection rate per fault size. Write the JSON to `docs/evidence/data/`.
4. **Delivery pack as a fixture.** Add `packs/deliveries/` with the generator, `ontology.yaml`, `data.yaml` and `evals/cases.yaml`. Cases: the planted week must name the warehouse and carrier together (D3, `gap`); the seven other weeks must be quiet.
5. **Small unit.** Add `bad_week:agent_023:wk6:0.15` on seeds 201 to 210 as a `gap` case (D4).
6. **Router cases.** Add the D6 questions to `packs/contact-centre/evals/routing.yaml` as `gap`.
7. **Sign-off and calibration unit tests** for D7 and D8 in `core/builder/test/`, written to fail today.
8. **CI.** Add a nightly workflow that runs the noise suite and uploads the rate table. Do not put the slow suite on every push.

### Loader note

The synthetic packs need the DuckDB CLI with its SQLite extension. In a locked-down environment that extension cannot download. Add a pure Python fallback in `packs/_lib/synthetic-prepare.mjs` that loads `raw/*.csv` into SQLite when DuckDB is missing. This also removes one install step for contributors.

### Done when

- `npm run eval` still reports 25 of 25, and the new suites run and report their gaps by name.
- The rate table exists in `docs/evidence/` and shows the D1 number, roughly 5 of 6 at noise 0.02.

## Phase 1: enforce the number rule in code

"The LLM never computes a number" must be something the software guarantees, because a regulated buyer cannot accept a promise that lives in a prompt.

### Design

Add a deterministic verifier and make the answer pass through it.

1. **`core/verify` (new package).** Input: the assistant's draft answer as text, plus the result records it may cite (`result.json` from a run, an exploration record, sign-off numbers). Output: a list of every number found in the text, each marked as *matched* (with the path of the field it came from), *rounded match*, or *unsupported*.
2. **Matching rules.** Parse integers, decimals, percentages, currency and ranges. A fraction of 0.8601 matches "86.0%" and "86%". Allow the display rounding the result format declares, nothing more. Dates and period labels are matched against the run's window. Counts of findings are matched against array lengths.
3. **Exemptions are explicit.** Ordinals, list numbering, and numbers quoted from the user's own message are allowed and labelled as such.
4. **An MCP tool, `check_answer`.** The assistant must call it with its draft before replying. It returns either `ok` with a citation map, or the unsupported numbers with the instruction to remove them or run a tool that produces them.
5. **A hard stop where the client allows it.** In `clients/claude-code/hooks`, add a stop hook that runs the verifier on the final message and blocks it when a number is unsupported. For clients without hooks, the skill requires `check_answer`, and the eval measures compliance.
6. **Derived numbers come from a tool.** Add a small `derive` operation (difference, ratio, share, per-period average) that takes result fields as inputs and returns a value with its inputs recorded. The assistant asks for a derived number; it never does the sum.
7. **Every answer carries its evidence.** The final answer ends with a short "where these numbers come from" block that the verifier generates: run id, tool calls, and row counts.

### Eval

- New agent-level score in `core/eval`: *unsupported-number rate* = answers with at least one unsupported number, over all answers.
- Run the Explorer and investigate cases 10 times each, on at least two models.

### Done when

- Unsupported-number rate is 0 over at least 100 live answers with the hook on.
- Without the hook, the rate is reported honestly per client and model.
- Unit tests cover the parser against at least 200 phrasings, including traps: "about a third", "roughly 2x", "up from 81% to 86%", "1 in 13".

## Phase 2: quiet weeks stay quiet, and planted faults match the detector

This is the phase that decides the project. The target is a false-alarm rate at or under 1 in 20 on noisy synthetic data and on the real complaints data, without losing the faults found today.

### Step 1: diagnose before changing anything

For each false alarm in the noise suite, record in `docs/evidence/noise.md`: which test raised it (headline, node finding, time bucket, masking flag), its z, the bar it cleared, and the node's own history. The likely causes, to confirm or reject:

- **Node tests still assume counting noise only.** The headline uses `estimateDispersion` and `adjustedZ` (`core/runner/src/dispersion.ts`), but node-level and time-bucket tests in the drill may not, outside the flat-whole path. The repo's own parked list says time-bucket z-scores and `standsOut` are not dispersion-adjusted.
- **Many comparisons, one bar.** Twelve teams, sixty agents, four queues and many time buckets are each tested. Benjamini-Hochberg across all nodes is deferred in `PROGRESS.md`.
- **Thin history.** Four baseline periods give a poor estimate of a node's own spread. The code falls back to counting noise under five periods.
- **The `dispersion@team` flag** fired on 4 of the 5 false alarms. Check whether it is a warning that should lower confidence, or a claim that counts as an alarm. Today calibration counts it as a claim.

### Step 2: fix, one change per commit

1. **One spread model for every test.** Each node and each time bucket is judged against its own period-to-period spread, estimated from its history, with a floor at counting noise. Where history is short, borrow strength: shrink the node's spread toward the spread of its siblings at the same level (a simple empirical-Bayes shrink is enough). Document the estimator in the code and in the paper.
2. **Control the false discovery rate across the whole run.** Apply Benjamini-Hochberg over every node and bucket tested in a run, at a level set per pack. Remove the ad hoc tenfold tightening (`FLAT_WHOLE_ALPHA`) only if the rates hold without it; report both.
3. **Require a material effect as well as a significant one.** A finding needs a minimum share of the headline change, or a minimum absolute move stated in the KPI's own units, set in the ontology with a safe default. The repo tried a materiality rule and dropped it because it hid a real case inside a flat whole; keep the flat-whole exception and test that case.
4. **Separate "noisy" from "changed".** A dispersion flag alone lowers the confidence label and is reported as a note. It is not a finding and not an alarm.
5. **Longer baselines when the data has them.** Default baseline stays 4 periods for the comparison, but the spread estimate uses up to 26.

### Step 3: make the fault planter and the detector agree

Hypothesis for D2, to confirm first: `core/builder/src/inject.ts` sizes a planted fault at about six standard errors of counting noise, while the detector judges against the node's historical spread. On data with wobble, six counting-noise errors can sit inside ordinary movement.

1. Size planted faults in units of the detector's own spread for that node: default 4 and 6 of those units, reported separately.
2. Report a small detection curve, not a pass or fail: fault size against share found.
3. `verified` requires the 6-unit faults found and states the smallest size reliably found. Put that sentence in the answer's confidence label.
4. Allow fault injection on BigQuery through a scratch dataset with an explicit cost go-ahead, or state clearly why not.

### Step 4: calibration on short history (D7)

1. When fewer than 8 quiet periods exist, say so before the replay starts, and say how many more weeks are needed.
2. Offer day-level replay where the pack has a day level and enough volume, so short histories can still be judged.
3. Report the upper bound of the interval beside the rate. 0 of 7 is not "none"; its upper bound is about 35%.

### Done when

| Measure | Today | Target |
| --- | --- | --- |
| False alarms, contact-centre, noise 0.02, 40 or more quiet weeks | about 5 in 6 | at most 1 in 20 |
| False alarms, clean data | 0 of 8 | unchanged |
| False alarms, complaints volume (real data) | 39% | at most 10%, with the interval stated |
| False alarms, complaints timely rate | 20% | at most 10% |
| Shipped eval | 25 of 25 | 25 of 25 |
| 12 unseen faults | 11 | at least 11 |
| Noise plus fault cases | not measured | at least 90% found |
| `inject_faults` on the delivery pack | 1 of 3 | all applicable kinds at 6 units |

If a target cannot be met, publish the number and the reason. Do not hide it.

## Phase 3: combinations and small units

A cause is often a combination, such as one carrier at one warehouse, and today Causeline reports the two halves as separate findings.

### Tasks

1. **Cross the top findings.** When two or more findings from different dimensions each explain most of the change, run one extra slice that crosses them (the generated slice tools already take filters). If one cell carries the change, report that cell as the finding and demote the two margins to context.
2. **Never double count.** The "explained share" across reported findings must not pass 100%. Add an invariant test.
3. **Bounded search.** At most the top 3 findings are crossed, pairs only, within the step budget. Larger interaction search stays parked.
4. **Cross-check with the warehouse where it exists.** On BigQuery, optionally call the built-in key-drivers function for the same window and record whether its top segment agrees. Disagreement is shown, not resolved silently. See Phase 7.
5. **Small units (D4).** When a child level is below `min_volume` for a week, test it over a longer window or pool it with its history, and report "too small to judge in one week" instead of silence. Add the smallest detectable effect per level to the result so the answer can say what it could not have seen.
6. **Time precision.** In the two-cause test, a Thursday 09:00 to 11:00 fault was reported as a Wednesday to Thursday day range. Where a finer level exists, narrow to it before reporting.

### Done when

- Delivery pack: the planted week names warehouse and carrier together as one finding.
- Contact-centre two-cause case: both causes found, the time block narrowed to the right half-hours.
- Agent-level `bad_week` at 15%: either found in at least 7 of 10 seeds, or reported as below the smallest detectable effect with that effect stated.
- No change to the Phase 2 false-alarm rates.

## Phase 4: governance a risk team can sign off

A regulated buyer asks four questions: who approved this, what exactly ran, what left the building, and can I replay it. Each needs a concrete answer in the product.

### Tasks

1. **Named sign-off.** Every confirmed number, label and incident records who confirmed it (a name or id the user gives once per project), when, and the source they named. Show it on the sign-off page. Today only the source is stored.
2. **Close the sign-off loophole (D8).** "Two periods" means two non-overlapping periods at the pack's main level. A day inside the same week does not count as a second period.
3. **Tamper-evident run log.** Append every run, exploration, sign-off and ladder change to a project log where each entry carries the hash of the one before. Add `causeline audit verify` to check the chain and `causeline audit export` to write a bundle (log, pack files at that version, results).
4. **Replay.** `causeline replay <run id>` re-runs a stored question against the same pack version and reports whether every number matches. A changed number names the data or definition change behind it.
5. **Pack versioning.** Each saved pack gets a content hash. A result records the pack hash, the playbook version, the Causeline version and the Toolbox version. A changed definition drops the KPI a rung, as the drift check already does for data.
6. **The data boundary, written down and enforced.** Add `docs/guides/data-boundary.md` stating exactly what reaches the LLM: aggregated result rows, labels and sentences; never raw rows unless the Explorer returns them. Add a project setting `llm_data: aggregates_only` that makes the Explorer refuse row-level reads and masks values under a minimum group size.
7. **Sensitive columns.** `describe_data` already skips free text. Add a per-column `sensitive` mark in the pack that keeps a column out of samples, profiles and results.
8. **Model independence.** Document running on Claude, Codex, and a model served inside the customer's own cloud. Record the client and model name in every result when the client exposes it.
9. **Read-only by construction.** Add a test that every generated tool is a single `SELECT`, and state the required database role in the admin message from `access_help`.
10. **A controls page.** One document, `docs/controls.md`, with a table: control, what enforces it (file and test), and how to evidence it. This is what a risk team reads first.

### Done when

- `audit verify` passes on a project and fails when one log line is edited by hand.
- `replay` reproduces a stored result to the last digit on SQLite and BigQuery.
- With `aggregates_only` on, no tool result in a 50-question run contains a row-level record. A test asserts it.
- `docs/controls.md` lists every control with a linked test.

## Phase 5: router and small bugs

These are cheap fixes that remove the rough edges a first-time evaluator hits.

### Router (D6)

1. **Wrong KPI is worse than no KPI.** "Are calls taking longer than usual?" matched `calls_offered` on the word "calls". Score a synonym match lower when a longer phrase in the question points at another KPI's description, and return the top two as a choice when scores are close.
2. **Fuzzy matching for typos**, with the same "offered, never guessed" rule the intent code uses for filter values.
3. **Keep what the question said.** A named value ("billing queue"), a date ("2026-02-19") and a relative period ("last Tuesday") must survive into the suggested inputs or come back as the one question to ask.
4. **Be clear about the split of work.** The router is the deterministic fallback; the assistant fills the intent. State that in the tool text so the assistant does not trust a low-confidence route.

### Small bugs (D9)

| Bug | Fix |
| --- | --- |
| Build guide says calibration and verification are "not built yet" | Update `skills/causeline-build` and the `get_guide` text; add a test that guide text names only rungs the tools can award |
| Explorer reports `read.queries: 0` after a query on SQLite | Count queries on every dialect |
| Router reports an expert as "draft" while its KPI is reconciled | Expert status is read from the KPI's rung in one place |
| `play_back` and `propose_checks` return a raw "file does not exist" path error before a pack is saved | Return the plain-words next step |
| `save_pack` rejects YAML strings with a schema error | Accept a YAML string or an object, or say in the error which is expected |
| README status section lags `PROGRESS.md` (lists finished work as planned, says 18 cases) | Generate the status block from `PROGRESS.md` in a script, checked in CI |
| Release workflow has never run | Run it; fix what breaks |

### Done when

- Routing eval passes the new cases with no loss on the existing 38.
- Each bug has a test that failed before the fix.

## Phase 6: packs for regulated industries

Three packs show the same engine on problems a regulated firm recognises. All use public or synthetic data and none touch supply chain.

| Pack | Data | The question it answers | State |
| --- | --- | --- | --- |
| Complaints | CFPB public table | Why did complaint volume or the timely-response rate move, and at which firm or product? | Exists; reframe as conduct and complaints reporting |
| Alerts | Synthetic transaction-monitoring alerts with a rule-change log | Why did alert volume or the share of alerts closed as false positive change? | Not started; already planned in `PROGRESS.md` |
| Claims | Synthetic insurance claims | Why did claims cycle time or the reopened-claims rate move? | New |

### Rules for all three

1. Each pack ships a generator with named, planted faults and a `faults.json` truth file, like the contact-centre pack.
2. Each covers the traps still open under "Coverage debt": a cross-table cause (a rule change in a log table), a decoy event that moved nothing, and two simultaneous causes.
3. Each has a held-out set of faults that are never used while developing. Claude Code must not read the held-out truth files; a script scores them.
4. Each reaches `verified` through the full ladder in a recorded run, or the README says which rung it reached and why.
5. The alerts pack is management reporting on alerts. It does not score, detect or rank suspicious activity, and its README says so in the first line.

### Done when

- Three packs pass their own evals and the noise suite.
- The held-out score is published for each.

## Phase 7: more databases and a warehouse cross-check

Banks and insurers mostly run Snowflake, Databricks, SQL Server or Postgres, so BigQuery-only keeps Causeline out of the room.

### Tasks

1. **Dialect layer.** The generator already has SQLite and BigQuery dialects. Add Snowflake and Postgres first (Toolbox supports both), then Databricks and SQL Server. Each dialect is a small file: date bucketing, week start, quoting, casts, limits.
2. **Parity is the test.** `scripts/parity.mjs` already compares SQLite and BigQuery. Extend it so every dialect must return identical results on the contact-centre eval. Postgres runs in CI in a container. Cloud dialects run on demand with the owner's credentials.
3. **Cost control per dialect.** Keep the per-question budget. Where a dry run does not exist, use the engine's own estimate or a row cap, and say which in the result.
4. **Warehouse cross-check.** Add an optional step that calls the warehouse's own contribution function for the same comparison (BigQuery's key-drivers function, Snowflake's `TOP_INSIGHTS`, Databricks' `ai_top_drivers`). Check the current documentation for each before coding; two of them were in preview or beta in late 2026. Record agreement or disagreement in the result as evidence. Causeline's own maths stays the source of the answer.
5. **dbt semantic layer import.** Read a dbt `semantic_manifest.json` and draft the ontology and data files from it, for the user to confirm through `play_back`. Many regulated teams already define metrics there.

### Done when

- Contact-centre eval is identical on SQLite, Postgres, BigQuery and Snowflake.
- The cross-check appears in results on at least BigQuery, with a test for an agreeing and a disagreeing case.

## Phase 8: the open benchmark

The benchmark is the launch asset. It must show, on faults nobody tuned for, that Causeline is right more often and wrong less often than a plain agent with SQL access.

### Design

1. **A separate folder, `bench/`**, with its own README. Tasks come from the four packs: each task is a dataset, a question, and a truth record.
2. **Three task types:** a planted fault to find; a quiet period where the right answer is "nothing unusual"; a trap (offsetting parts, pure mix, Simpson's paradox, missing data, a decoy event, two causes, a combination).
3. **At least 200 tasks**, generated from seeds that were never used in development. Freeze them with a hash before the first scored run.
4. **Systems compared:**
   - Causeline with each supported model.
   - The same model with a plain SQL tool on the same database and a short, fair prompt.
   - The same model with the warehouse's key-drivers function available.
5. **Scores:** correct cause named; false claims on quiet periods; traps handled; share of stated numbers that are correct to the digit; queries and cost per task; run-to-run agreement over 5 repeats.
6. **Fairness rules, written in the README:** same data, same question text, same model version, prompts published, every transcript published, failures of Causeline listed first.
7. **A grader that is code, not a model**, for the cause and the numbers. A model may grade only the wording, and that score is reported separately.

### Rules for Claude Code

- Do not look at benchmark truth files while working on Phases 2 and 3.
- Do not change the engine after the freeze and before the scored run. If a fix is needed, cut a new benchmark version.

### Done when

- `bench/RESULTS.md` holds the table, the intervals, and a "what Causeline got wrong" section.
- One command reproduces it: `npm run bench -- --model <name>`.

If the plain agent wins or ties on some task types, publish that. It tells the owner where the product is not yet worth its setup.

## Phase 9: two-minute demo, README, first release

A visitor must see a correct, audited answer within two minutes and without installing anything beyond Node.

### Demo

1. **`npx causeline demo`.** Publish the package to npm (remove `private: true` from what is published). The command generates the contact-centre data with the pure-Python or pure-Node loader from Phase 0, starts everything, runs one planted-fault question, and prints the answer with its evidence block.
2. **No Toolbox for the demo.** `core/builder/src/sqlite-tools.ts` already calls SQLite without Toolbox. Use that path for the demo so there is no 300 MB download before the first answer. Toolbox stays for real databases.
3. **A recorded run in the README.** A short terminal recording or a screenshot of the answer, the evidence block and the sign-off page.
4. **A hosted, read-only sample page** built from the companion pages, showing one project: the ladder, how the steps decide, and three results.

### README, one screen

Order: one-line promise; the answer screenshot; the measured table (false-alarm rate, detection curve, benchmark headline, unsupported-number rate); three commands to try it; "what it is not"; links out to guides. Everything else moves to `docs/`.

### Repo hygiene

- Description, topics and a social preview image on GitHub.
- `CONTRIBUTING.md`, `SECURITY.md`, a code of conduct, issue templates, and a "good first pack" guide.
- `CHANGELOG.md` and a tagged `v0.1.0`, with the release workflow producing the binaries and the Claude Desktop extension.
- Install tested on a clean macOS, Windows and Linux machine, each recorded in evidence.

### Done when

- A person with only Node installed gets the demo answer in under two minutes on all three systems.
- The README fits one screen before the first heading that needs scrolling, and its numbers are generated from evidence files by a script.

## Phase 10: the validation paper

A risk team will read a validation document before it reads any code, so the project needs one that is short, specific and honest.

### Contents of `docs/validation.md` (also exported as a PDF)

1. **Purpose and scope.** What Causeline does, what it does not do, and where a human decides.
2. **Design.** Which component computes, which component writes words, and the controls between them. Link to `docs/controls.md`.
3. **Method.** Each statistical test in plain words and in formulas: the comparison, the spread estimate, the shrink toward siblings, the false-discovery control, the materiality rule, rate against mix, the masking checks. One worked example each.
4. **Assumptions and limits.** Minimum volumes, minimum history, smallest detectable effect by level, what it cannot see (unrecorded causes, effects with a lag, more than pairs of dimensions).
5. **Measured performance.** False-alarm rate by noise level with intervals; detection curve by fault size; trap handling; benchmark results; unsupported-number rate; run-to-run agreement. Every figure links to its data file and script.
6. **Ongoing monitoring.** The drift check, calibration replay, what lowers a rung, and how to re-validate after a change.
7. **Change control.** Pack hash, versions in every result, the audit log and replay.
8. **Known failures.** The cases Causeline still gets wrong, listed by name.
9. **How this maps to common model-risk expectations.** A table against the themes UK regulators name in public: risk tiering, explainability, data quality, independent validation, ongoing monitoring, third-party dependence. State that this is the author's mapping and not legal or regulatory advice, and that a firm must run its own validation.

### Rules

- No claim without a number, and no number without a file.
- Written after Phases 2, 4 and 8, generated where possible from the evidence files.

### Done when

Someone who has never seen the repo can read the paper in 20 minutes and say what Causeline guarantees, what it measures, and where it fails.

## Launch and adoption (the owner's tasks)

Code alone will not make this a hit; five real users and one credible public result will. Claude Code prepares the materials below, and the owner does the talking.

### Before launch

- [ ] Phases 0 to 2 done and their numbers published, even if a target was missed.
- [ ] Benchmark table and validation paper live in the repo.
- [ ] Demo works on three clean machines.
- [ ] The repo contains nothing from an employer: no data, names, code or domain content. Know what your contract says about side projects before going public.

### Launch pieces (Claude Code drafts, owner edits and posts)

1. **The benchmark post.** "We planted 200 faults. Here is how often an AI analyst with SQL gets the cause right, and how often it invents one." Lead with the plain agent's false-claim rate on quiet weeks and Causeline's beside it.
2. **The failure post.** "Our tool raised a false alarm in 5 of 6 quiet weeks. Here is how we measured it and fixed it." Honest posts travel further than polished ones.
3. **The design post for risk people.** "How to let an LLM explain numbers it is not allowed to compute." Link the controls page.
4. **A 90-second screen recording** of the demo and the sign-off page.

Channels: LinkedIn first, then Hacker News (Show HN), the MCP and dbt communities, and a short talk proposal for a data or model-risk meetup.

### Design partners

- Aim for 3 to 5 teams in regulated firms: analytics, complaints and conduct reporting, financial-crime operations reporting, claims operations.
- Offer: two hours of setup help on one KPI, on their data, inside their cloud. Ask: permission to publish anonymised time-to-verified and what broke.
- Prepare a one-page brief for each conversation: the problem, the controls page, the benchmark headline, and what data leaves their environment.
- Use `docs/guides/tester-kit.md` and `tester-feedback.md`, which already exist. Turn every piece of feedback into an eval case.

### Measures that say it is working

| Measure | First target |
| --- | --- |
| People who ran the demo to the end | 100 |
| External people who built a pack on their own data | 10 |
| Design partners with a KPI at `reconciled` or higher | 3 |
| Median time from install to first answer | under 15 minutes |
| Median time to `reconciled` | under one afternoon |
| External contributors with a merged pull request | 5 |
| Conversations with teams you would want to work with | 10 |

Stars are a side effect. Do not optimise for them.

## Scoreboard, order of work, and what not to build

Work in this order; do not start a phase until the one before it has met its "done when" or the owner has accepted a published miss.

| Order | Phase | Why now | Rough size |
| --- | --- | --- | --- |
| 1 | 0: failures become tests | Nothing can be fixed safely without it | Small |
| 2 | 2: noise and fault planter | The product is not usable on real data until this is done | Large |
| 3 | 1: number rule in code | The core promise must be guaranteed | Medium |
| 4 | 5: router and small bugs | Cheap, removes first-run friction | Small |
| 5 | 3: combinations and small units | Makes answers match how causes really look | Medium |
| 6 | 9: demo, README, release | People can finally try it | Medium |
| 7 | 4: governance | Needed before any regulated pilot | Medium |
| 8 | 6: regulated packs | Gives the benchmark its breadth | Medium |
| 9 | 8: benchmark | The launch asset | Medium |
| 10 | 10: validation paper | Written from the results above | Small |
| 11 | 7: more databases | Unlocks most regulated firms | Large |

Phase 9 can ship a first version early with the contact-centre pack only, then be refreshed after Phase 8.

### The scoreboard (keep it at the top of `PROGRESS.md`)

| Number | Today | Target |
| --- | --- | --- |
| False-alarm rate, noisy synthetic | about 83% (5 of 6) | at most 5% |
| False-alarm rate, real complaints data | 39% and 20% | at most 10% |
| Unseen planted faults found | 11 of 12 | at least 11 of 12, on a larger set |
| Faults found by `inject_faults` on a noisy pack | 1 of 3 | all at 6 units |
| Unsupported numbers in live answers | 2 of 5 runs had one | 0 in 100 |
| Combination cause named as one finding | no | yes |
| Benchmark margin over a plain agent with SQL | not measured | published, with intervals |
| Time to a first answer from nothing | long, several installs | under 2 minutes |
| External users with their own pack | 0 | 10 |

### What not to build

- Monitoring and alerting. Causeline explains a change someone already noticed.
- A hosted service, accounts or billing.
- Dashboards or chart builders. The companion pages stay read-only.
- Free-form SQL from the model, under any name.
- Detection of fraud or financial crime.
- More clients, more Explorer operations or more playbook language until the scoreboard is green.
- Anything that makes a number look better without making the analysis better.

### First message to give Claude Code

```markdown
Read docs/BUILD_GUIDE.md fully, then PROGRESS.md, decisions.md and docs/evidence/calibration.md.
Start Phase 0 only. Follow the working rules in the guide.
Before writing code, reply with: your plan for Phase 0 as numbered steps,
the files you will touch, and anything in the guide you think is wrong or unclear.
Wait for my go-ahead.
```

Save this guide in the repo as `docs/BUILD_GUIDE.md` so every session starts from the same page.

## Sources

Found by web search in November 2026; check each for changes before relying on it.

- [BigQuery AI.KEY\_DRIVERS function](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/bigqueryml-syntax-ai-key-drivers)
- [Snowflake TOP\_INSIGHTS](https://docs.Snowflake.com/sql-reference/functions/top_insights)
- [Databricks ai\_top\_drivers](https://docs.databricks.com/aws/en/sql/language-manual/functions/ai_top_drivers)
- [Atoti Intelligence overview](https://docs.activeviam.com/atoti-intelligence/6.1/intro/intro.md)
- [ThoughtSpot Spotter](https://www.thoughtspot.com/blog/everyone-gets-an-ai-analyst)
- [Addleshaw Goddard: AI in UK financial services, a regulatory map](https://www.addleshawgoddard.com/en/insights/insights-briefings/2026/financial-services/artificial-intelligence-uk-financial-services-regulatory-map-practical-considerations/)
- [Covington: UK financial services regulators' approach to AI in 2026](https://www.covingtonblogs.com/2026/04/09/uk-financial-services-regulators-approach-to-artificial-intelligence-in-2026/)
