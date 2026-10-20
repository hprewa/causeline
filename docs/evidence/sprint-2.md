# Sprint 2 evidence: multi-point sign-off, Builder on BigQuery, complaints pack

What each step shows and, as important, what it does not. The plan is in the sprint's step table in `PROGRESS.md`.

## Step 1: spike and measure (read-only; nothing merged except this record)

**Question:** can the complaints pack run on the public CFPB table at an acceptable cost, and do the BigQuery primitives the Builder needs behave as the plan assumes?

**Method:** a throwaway pack (3 KPIs, 2 hierarchies, 3 flat concepts; the fact selects 10 columns of `bigquery-public-data.cfpb_complaints.complaint_database` and
wraps `date_received` in `TIMESTAMP(...)`) was written in a scratch folder, tools generated (53), and three deep dives run through the real Toolbox and the cost meter with
no budget. The table: 3,458,906 rows, 2.3 GB, 2011-12-01 to 2023-03-23 (frozen: last modified March 2023).

**Results**
| Run | Outcome | Queries | Read | At list price |
|---|---|---|---|---|
| timely response rate, week of 2017-09-04 | complete; top finding `company = EQUIFAX, INC.`, then the day 2017-09-08..09 | 16 | 9.7 GB | $0.055 |
| complaint volume, same week | complete; Equifax within the credit-reporting subproduct, and the web channel | 19 | 11.6 GB | $0.066 |
| monetary relief share, week of 2020-04-06 | complete; no finding | 15 | 10.3 GB | $0.059 |
Each run took 26 to 36 seconds.

- **The Equifax breach week is found with no tuning**: the incident the plan names as an eval case is visible to the existing analysis. (Whether it becomes an eval case is
  decided in step 6, after the incident is checked in the data on purpose.)
- **A deep dive reads about 10 to 12 GB**, because the table is unpartitioned and every query scans each column it references, whatever the window: roughly 600 MB a query.
  That is **above the default 5 GB budget**, so the default would stop every deep dive on this pack. The cost is small ($0.06 a question), so the plan's mitigation applies:
  a per-pack budget declared in `data.yaml` (to be added in step 4; the environment variable still overrides), not a per-run extract.
- **Dry runs report the statement type and the result schema**: a SELECT is reported as `SELECT` with its column names and types, so the Builder can use the dry run as the
  authoritative read-only check and as the source of column types. A statement against a dataset that does not exist fails the dry run (so a write to nowhere is refused either way);
  the type reported for a real DML statement was not exercised (no dataset of ours is in scope for it), and the Builder will keep its textual guard as well as the type check.
- **Profiling costs are known**: a profile query of ten columns (nulls and approximate distinct counts) is 738 MB; the narrative column alone is 1.29 GB and is to be skipped;
  `INFORMATION_SCHEMA.COLUMNS` is 10 MB; a 1% `TABLESAMPLE` with a limit is 129 MB. So BigQuery profiling is a few hundred MB per table with a column filter, and an
  automatic skip of long free-text columns is worth building.
- **A local web server inside the stdio MCP process** needs nothing beyond `node:http` on 127.0.0.1; not exercised here (the screen is step 3).

**Not shown:** the cost of the Builder's own queries (profiling joins and hierarchies), a deep dive on a smaller window with a narrower fact, behaviour of dry-run `statementType` for DML,
and any property of the sign-off ladder (steps 2 and 3).

**Plan adjustments:** (1) add `budget_gb` to `data.yaml` (step 4). (2) The profile skips free-text columns and filters columns before scanning (step 4).

## Step 2: checks and the status ladder (core, SQLite, no screen yet)

**Question:** can a KPI be taken from draft to provisional to verified by stored, re-runnable numbers and automatic checks, with the status worked out from what is stored rather than set?

**What was built** (`core/builder/src/checks.ts`, `state.ts`; `build.json` is now version 2, a version 1 file is read as 2):
- **The ladder is derived, not stored by hand** (`levelOf`): *draft* (nothing confirmed, or an automatic check fails), *provisional* (one confirmed number), *verified* (automatic checks pass,
  nothing flagged, at least two confirmed numbers of different kinds, each with a named source). A confirmed number with no source does not count towards the second angle; a flagged
  number blocks verified; an automatic failure outranks matching numbers.
- **Proposed checks** (`proposeChecks`): by rule: the whole data over the last complete period, the biggest part of the first hierarchy and of one flat concept, and one day (a different grain);
  an odd period the person names. The tools' numbers are worked out and stored but **not offered with the question**: they are revealed only after the person's own number is in (`recordNumber`).
- **Confirming**: a number is confirmed only if it matches the tools' within a tolerance (a percentage said as 93.1 is read as 0.931 for a rate); a mismatch returns both numbers and where to look
  (which date decides the period, week start, where midnight falls for a single day, what is counted). Flagging is always allowed.
- **Automatic checks** (`autoChecks`, never shown unless they fail): days add up to the top level; every split by a hierarchy level or flat concept adds up to the whole; no join repeats rows
  (needs the new optional `one_row_per: {table, column}` on a fact; without it the check says it was not run, which is neither a pass nor a failure); and the existing shape and range checks
  (`single_parent`, `time_column_complete`, `values:<kpi>` gate the KPI; gaps, thin days and empty columns are reported as notes, not held against it).
- **A change drops a KPI**: saving a pack with a changed formula or fact SQL clears the automatic result and the unanswered proposals; confirmed numbers stay on record but no longer vouch for it,
  so the KPI is at most provisional, and a verified expert on it goes back to draft. `runChecks` re-works every stored number and the automatic checks; a number that no longer matches goes back
  to pending with the new figure beside it, and only when all match does the KPI get verified again.
- **The one-number path still works**: `reconcileMetric` now stores its match as a confirmed `total` check (provisional). `verifyExpert` requires a *verified* KPI plus the incident cases.

**Evidence**
- 11 new unit tests in `core/builder/test/checks.test.ts` run the generated query statements on a SQLite file (no Toolbox) with the expected numbers worked out in the test from the raw rows:
  the ladder rules table; version 1 to 2 upgrade; proposals hide numbers; draft to provisional to verified with a wrong number refused first; a flagged number blocks verified; a changed formula drops
  the KPI and the expert, and `run_checks` restores it when the formula only changed in wording but does **not** when the meaning changed (every stored number reported "no longer matches" and the KPI is
  back to draft); a join that repeats rows is caught (462 rows against 336 distinct ids); a split that loses a row fails `parts_add_up`; no `one_row_per` is reported as skipped; a sum KPI.
- The Builder end-to-end test on the real Toolbox (`npm run test:integration`) now goes: one reconciled number gives *provisional* and `verify_expert` refuses ("service_level is not verified yet
  (it is provisional)"); a second number of a different kind (one day, from the raw CSVs) gives *verified*; then the expert verifies. 6/6 integration tests pass.
- A scripted run on the contact-centre example (real Toolbox, planted-fault data), recorded below. All other tiers unchanged: every package's unit tests pass, runner evals 18/18,
  routing 27/27, intents 16/16, core purity OK.

```
[after save] level=draft -- no number has been confirmed yet
proposals (no tool numbers shown):
  total-1: What does your own report say for The whole business, 9-15 March 2026? ...
  slice-1: ... Centre cc_1, 9-15 March 2026? ...   slice-2: ... Queue sales, 9-15 March 2026? ...
  grain-1: ... The whole business, on 15 March 2026? ...
user says 50 for the whole business: match=false, tools said 0.8099; hints: the tools give a number 62% above yours | check which date decides the period ...
user gives 0.8099: confirmed=true, level=provisional
automatic checks: ok days_add_up:day; ok parts_add_up:centre/site/team/agent/queue/call_reason; ok no_repeated_rows; ok single_parent:*; ok time_column_complete; ok values:service_level
second number (Centre cc_1, 9-15 March 2026): confirmed=true, level=verified
same meaning rewritten -> needs checking: service_level   [level=provisional: automatic checks not run since the change]
run_checks: provisional -> verified, restored=true; re-worked 2 stored numbers, all match=true
```

**Not shown**
- Any way to reach this from the MCP tools or a screen: `propose_checks`, `confirm_number`, `signoff_status`, `run_checks` and the page are step 3. **Until then the Builder over MCP can reach provisional
  (`reconcile_metric`) but not verified**, so a live Builder run between steps 2 and 3 cannot produce a verified expert.
- The "other system" here is the raw CSVs the data was loaded from, read by test code: it proves the arithmetic and the wiring, not that a real report agrees; that comes with the complaints pack (steps 6 and 7).
- BigQuery: the automatic checks run one query per hierarchy level and flat concept, plus the shape checks, on each refresh; their cost on a large table is not measured yet (steps 4 and 5).
- A change in the *data* (not the formula) is not noticed; only `run_checks` run by hand re-works the numbers. A start-up drift check is sprint 5.
- `one_row_per` is declared on the contact-centre pack's SQLite fact only; counting the source table goes through the local database, and the BigQuery equivalent comes with the Builder's data layer (step 4).
- `package-lock.json` also picked up two dependencies of the MCP server that had been missing from it since sprint 1 (`connect-bigquery`, `intent`).

## Step 3: sign-off tools and the local sign-off screen

**Question:** can the ladder be used through the MCP server and a real screen, with the screen and the chat doing exactly the same things, and the page safe to serve from a local process?

**What was built**
- Five MCP tools: `propose_checks` (questions only, no numbers of ours), `confirm_number` (the user's number and its source; confirmed if it matches, ours revealed in the answer; `flag` records and flags instead),
  `signoff_status`, `run_checks`, `open_signoff` (starts the page and tries to open a browser; always returns the address). Tool descriptions say never to confirm a number the user did not give.
- `core/mcp-server/src/signoff.ts`: `node:http` on `127.0.0.1`, random port, a secret in the path, started on first use and unref'd. The page's actions (suggest, give a number, confirm or flag, re-run) call
  the same Builder functions as the chat tools, so there is one code path; it cannot edit the model, SQL or playbooks. `signoff-page.ts` is one HTML file: no external scripts, fonts or images; light and dark;
  everything from the server is set as text; a per-response nonce on the one script and one style.
- Protections: secret path (timing-safe compare), `Host` must be this machine (DNS rebinding), `Origin` must be absent or this page, writes must be `application/json` (a foreign page cannot send that without a
  preflight we do not grant), 64 KB body limit, CSP `default-src 'none'; connect-src 'self'`, `no-store`, `nosniff`.
- `SqliteToolCaller` (the generated statements run on the workspace database without Toolbox) moved from test code into `core/builder` so the screen is tested with the real statements.

**Evidence**
- 4 HTTP-level tests (`core/mcp-server/test/signoff.test.ts`): no secret / wrong secret 404; a foreign Host or Origin 403 (reads and writes); non-JSON 415; bad JSON 400; oversize 413; the page is self-contained with a
  matching nonce and a hostile `?kpi=` is escaped; a whole sign-off driven through the page's own calls (wrong number refused with hints and ours revealed afterwards; no source refused; right numbers give provisional then
  verified; a flagged number holds it at provisional; stored checks re-run) with the chat tool seeing the same state; the chat tools do the same (odd period, flag, confirm, re-run).
- `scripts/signoff-demo.mjs` plays it through the real stdio MCP server and Toolbox on the contact-centre example (numbers worked out from the raw CSVs by the script). Output:

```
status: "draft"
system proposes (no numbers of ours with the questions):
  total-1: The whole business, 9-15 March 2026 / slice-1: Centre cc_1, 9-15 March 2026 / slice-2: Queue sales, ... / grain-1: The whole business, on 15 March 2026
user (chat) gives 70% for the whole business: confirmed=false; ours 80.99%; the tools give a number 15.7% above yours
user (chat) corrects it: confirmed=true; level=provisional; needs one more confirmed number of a different kind from total, from a named source
open_signoff: http://127.0.0.1:<port>/<secret>/?kpi=service_level (browser started: false, as the demo asks)
the screen shows: provisional; total-1:confirmed, slice-1:pending, slice-2:pending, grain-1:pending
person at the screen types a slightly wrong number for cc_1: match=false; ours 80.83%; hints: 3
person at the screen enters the right one and presses Confirm: level=verified
the chat tool sees the same: verified; total-1:confirmed (the weekly report (raw calls file)), slice-1:confirmed (the centre report), ...
verify_expert (needs a verified KPI and the incident): verified=true
```
- Pictures of the page (headless Edge, same data): `docs/evidence/sprint-2/1-one-number-confirmed.png`, `2-a-number-that-does-not-match.png`, `3-verified.png`, `4-verified-dark.png`.
- Unit tests in every package pass (mcp-server 11 of 16 run, the 5 integration ones skipped), integration 6/6, runner evals 18/18, core purity OK.

**Not shown**
- **A person using the page in a real browser.** The pictures are headless renders of the real page, and the clicks in the demo are the page's own HTTP calls sent by a script; no one has clicked the buttons. That is the checkpoint review.
- **Whether a real MCP client (Claude Code) can reach the page**: `open_signoff` starts a local browser with `start`/`open`/`xdg-open` and returns the address; it was run here with the browser start switched off.
- The screen is not protected against another program running as the same user on this machine that has read the secret address (it is a local convenience, not a login). The address is shown only in the tool result.
- Mobile layout was designed for (16px gutter, stacking fields) but not looked at on a phone.
- The Claude Code plugin bundle and the `causeline-build` skill are not updated yet (step 5): the plugin still carries the previous server and skill.

## Step 4: the Builder on BigQuery (data layer, connect, profile, test, save)

**Question:** can a pack be built by the Builder's tools from a BigQuery table, with every read priced first and nothing written, and reach `verified` through the ladder?

**What was built**
- `core/builder/src/data.ts`: `BuilderData` (query, check, tables, quote/ref, usage, close) with the local database and BigQuery behind it. `connect-bigquery` (which now depends on the Builder, not the other way round)
  provides `BigQueryData` and registers itself; the Builder stays free of any cloud library. Profiling, `test_fact`, `save_pack` and the sign-off's repeated-rows check all go through it.
- **`connect_bigquery {table | dataset, project?, location?}`**: checks the sign-in and project with a free dry run, reads table descriptions only (rows, bytes, columns), writes `toolbox/source.yaml` (with
  `maxQueryResultRows`, no `writeMode: blocked`) and records the connection in `build.json`. The project is remembered for the folder; the environment variable still wins. Refuses a folder that already holds the
  user's own files, and says in words what to do when the account cannot reach a table.
- **Every statement on BigQuery is dry-run first (free).** It must be a SELECT by BigQuery's own statement type (the textual guard, now dialect-aware and blind to backticked names, is the first check), and it is refused
  before it is sent when it would take what one step has read past the budget (default 5 GB, `CAUSELINE_BQ_BUDGET_GB`). Results report what was read.
- **Profile (`describe_data`) on BigQuery** reads as little as it can: metadata is free; one small `TABLESAMPLE` gives example values and finds free-text columns (which are then never read); one aggregate pass over the rest
  gives empty counts, approximate distinct counts and ranges; one pass finds which columns sit under which. A pass that would pass the budget is run on a sample instead and says so. It points out a data set that stopped long
  ago (`as_of: data_end`), a DATE time column (the generator needs a TIMESTAMP), columns it could not profile, and columns that are *almost* a level.
- **`save_pack` on BigQuery**: the dialect and source are written from the connection, never by the agent; a DATE time column is an error with the exact fix (`TIMESTAMP(col)`); all KPIs of a fact are tried in one pass;
  and `budget_gb` is set in `data.yaml` from the dry-run size of one pass over the fact (25 passes, at least 5 GB) with a plain warning of what a deep dive is expected to read. `data.yaml` takes `budget_gb`, and
  `withCostControl` now uses: the environment, else the pack's figure, else the default.

**Evidence**
- Unit tests with fake databases (6 new in `builder`, 7 in `connect-bigquery`): the dialect guard (writes, `MERGE`, `EXPORT`, `CALL`, hidden `UPDATE` after `WITH`; a table called `update_log` and a word in a string are not verbs); BigQuery
  statement types other than SELECT refused before anything is sent; cumulative budget refused before the query that would pass it; value normalisation and quoting that cannot be closed early; connect writes a source that
  `sourceProblem` accepts and remembers the project; mixed folders, missing project, a missing table, views and large datasets answered in words and nothing written on failure; profile skips free text and list columns, finds
  roles, nulls, hierarchy and the as_of note, falls back to a sample with scaled counts; a DATE time column refused; the budget set from a dry-run size even when a cache answered the query; budget precedence.
- All suites, purity, integration 6/6, runner evals 18/18, intents 16/16 unchanged-green.
- **Live, through the real stdio MCP server and Toolbox** (`scripts/bigquery-build-demo.mjs`, billed to the project from `CAUSELINE_BQ_PROJECT`):
  - `--example` (the contact-centre data loaded to a small dataset of the user's own): connect (read 0), describe_data (0.02 GB, 7 queries: tables, hierarchy centre > site > team > agent, the join, the as_of note), save_pack (0.01 GB, 57 tools),
    propose_checks, two numbers (from the raw files) confirmed through `confirm_number` -> **verified**, all 14 automatic checks pass on BigQuery (including repeated rows, counted with `COUNT(DISTINCT call_id)`), incident recorded,
    `verify_expert` -> **verified**. Builder steps read 0.04 GB in all (about $0.0002).
  - `--public` (CFPB complaints, 3,458,906 rows, 2.3 GB): connect read nothing; **describe_data read 1.71 GB in 3 queries (about $0.01)** on its first run (repeat runs are answered from BigQuery's cache and read 0.13 GB); it left out
    `consumer_complaint_narrative` as free text (profiling it would have added about 1.3 GB), found `date_received` 2011-12-01 to 2023-03-23 and said to set `as_of: data_end`, flagged DATE, and found **no hierarchy**: it reported that
    `subproduct` is close to a level under `product` but **19 of its 76 values appear under more than one product** (names like "Other"), and said how to fix it. `test_fact` with the DATE left as it is warned (and `save_pack` would refuse);
    with `TIMESTAMP(date_received)` it counted 3,458,906 rows at 0.74 GB a pass; `save_pack` saved 38 tools and set **`budget_gb: 19`** (25 passes of 0.74 GB) with the warning that a deep dive reads about 14.8 GB (about $0.08);
    `propose_checks` ran the generated tools through Toolbox metered: the last complete week 13-19 March 2023, the biggest product, the biggest state, and one day.

**Not shown**
- **A language model driving the Builder on BigQuery** (steps 5 and 6). Everything here was driven by a script that plays the model.
- **A deep dive on the complaints pack** under the 19 GB budget (step 6), and the Builder's automatic checks on the complaints table (step 6): their cost on 3.4 M rows has not been measured; the example's were tiny.
- **The hierarchy pass at scale beyond this table**, and join detection beyond one pair of small tables. The hierarchy pass looks only at the 8 text columns with the fewest values and says when a table was only sampled.
- Approximate distinct counts are used (about 1% error), so "every value different" is read with 3% of room; a key could be missed or a near-key accepted. The checks that matter are exact (`single_parent`, `no_repeated_rows`).
- A sign-in that has expired mid-run surfaces as the raw Google error in the demo script's own setup; through the tools it is explained in a sentence (the explainer is from sprint 1), but this was not provoked live.
- Dataset `causeline_build_demo` (about 10 MB) was created in the project by the demo's setup and is still there; delete it when you like (`bq rm -r -f -d yukti-dev:causeline_build_demo`).

## Step 5: skill rewrite and scripted end-to-end on both databases

**Question:** does the instruction the model follows teach the new ladder and BigQuery correctly, and does the whole Builder path (connect, look, describe, save, sign off, verify, change, restore) work through the MCP tools on both databases?

**What changed**
- `skills/causeline-build/SKILL.md` rewritten: the description and triggers cover BigQuery; rule 4 teaches the three states (draft, provisional, verified) and to call anything short of verified *unconfirmed numbers*; new rules that the model never
  confirms a number the user did not give and never uses one KPI's figure for another, and that it says what reading costs (and never hides a budget stop). Step 1 has a BigQuery branch (their own billing project; a fresh folder; the user runs `gcloud auth application-default login`
  themselves; connecting reads no data). Step 2 passes on the profile's notes in a sentence each and handles an almost-level column by making names unique. Step 3 adds `one_row_per`, the BigQuery SELECT rules (backticked full names, `TIMESTAMP(...)`, narrow columns,
  no free text) and the cost sentence after a save. Step 5 is now the sign-off: propose, ask for their number and its source **before** showing ours, confirm with a source, flag, two angles for verified, the sign-off page, `run_checks` after any change. Step 7 needs a verified KPI.
  `source`, `dialect` and the cost limit are no longer the model's to write.
- `skills/causeline-investigate/SKILL.md` gains one rule: say, once, when a KPI is not yet verified (via `signoff_status`), and offer to confirm it.
- `save_pack` fills in `data.source` from the connection when the draft leaves it out (it already did so for BigQuery), found when the scripted path used the new skill's draft shape.

**Evidence**
- `core/mcp-server/test/builder-flow.test.ts` (integration; Python and Toolbox): from raw CSV files through the MCP tools over stdio to a verified expert: connect, look, save (source left out), play back and confirm, propose (no number of ours in the questions), a wrong number refused,
  one number gives provisional and `verify_expert` refuses, the **second number is given through the sign-off page's own HTTP calls** and the chat sees verified, the incident, `verify_expert` verified, then a rewritten formula drops the KPI to provisional and `run_checks` restores it.
  The `build_status` next step names the next KPI that is not verified. 7/7 integration tests pass (this one, the Builder end-to-end, the MCP run, the multi-message intent conversation, and the bundled plugin from a copy).
- `core/mcp-server/test/skills.test.ts`: the build skill names every sign-off tool and each exists in the server; it no longer teaches that one matched number is enough; it teaches asking before showing ours and the sign-in command.
- **BigQuery, same path** (`scripts/bigquery-build-demo.mjs --example`, run again on the final code): connect (0 read), describe_data (0.02 GB), save_pack (0.01 GB, 57 tools), propose, two confirmed numbers, **verified**, 14 automatic checks pass on BigQuery, `verify_expert` verified; Builder steps 0.04 GB in all.
- The Claude Code plugin was rebuilt with `npm run bundle:plugin` (3.6 MB) and the plugin-from-a-copy integration test passes (the plugin's server, skills and playbooks are build output and not committed).
- Unchanged and green: every package's unit tests, purity, runner evals 18/18, routing 27/27, intents 16/16 (fixture tier).

**Not shown**
- **A language model following the new skill.** Only scripts played the model; the wording of the skill is checked by tests for what it names and teaches, not by an agent's behaviour. The live conversation on the complaints data is step 6.
- The BigQuery end-to-end needs credentials and a project, so it is a script you run (it is not in `npm run test:integration` or CI).
- The sign-off page was driven by HTTP calls, not clicked; no one has used it in a browser yet (the hands-on mode exists: `node scripts/signoff-demo.mjs --hands-on`).
- The live agent tier of the intent eval (conversations to intents) was not re-run: nothing in the intent path changed.

