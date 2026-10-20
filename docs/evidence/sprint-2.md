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

