# Sprint 1 evidence

Honest record of what each step showed and did not show. Project, account and dataset identifiers are deliberately
left out: they come from the environment (`CAUSELINE_BQ_PROJECT`, `CAUSELINE_BQ_DATASET_PREFIX`).

## Step 1: BigQuery spike

**Question:** does MCP Toolbox 1.14.0 run the kind of statement the generator will emit against BigQuery, with named
parameters, and can the existing runner client call it?

**Setup:** the synthetic contact-centre data (120,000 calls, 2026-01-05 to 2026-03-15, plus the agents table) was
loaded into a new dataset with an explicit schema (`ts` as `TIMESTAMP`). A one-tool Toolbox config was written by hand:

```yaml
kind: source
name: bq-db
type: bigquery
project: <project>
location: US
---
kind: tool
type: bigquery-sql
source: bq-db
parameters:
  - { name: cur_start, type: string, ... }
  - { name: queue, type: string, required: false, default: "" }
statement: |
  SELECT COUNT(*) AS n, SUM(answered_within_20s) AS ok FROM `<dataset>.calls`
  WHERE ts BETWEEN TIMESTAMP(@cur_start) AND TIMESTAMP(@cur_end) AND (@queue = '' OR queue = @queue);
```

**Result (through the same `SdkToolCaller` the runner uses):**

| Call | Rows returned | Direct BigQuery query |
|---|---|---|
| a week, no queue | n 11701, ok 9530 | identical |
| same week, `queue=billing` | n 2983, ok 2416 | n identical |
| same week, `queue` omitted | same as no queue | n/a |

**Confirmed:**
- Toolbox 1.14.0 accepts `type: bigquery` sources and `bigquery-sql` tools with **named `@param` parameters**.
- An optional parameter with default `""` behaves like the SQLite tools' optional slot parameters, so the
  "optional filter on every concept" design works unchanged.
- String parameters compare against a timestamp column through `TIMESTAMP(@param)`.
- Toolbox runs a **dry-run job before each query** (visible in the error when credentials failed). Cost control can
  build on this, but the byte count is not returned to the caller; the planned `CostMeter` stays necessary.
- Authentication is Application Default Credentials. Two separate logins are needed on a machine: `gcloud auth
  login` (for `bq`) and `gcloud auth application-default login` (for Toolbox and Node clients). An expired ADC file
  fails with `invalid_grant`, which is the error a user would see; the connection check (step 4) must translate it.
- Toolbox's native `/api/tool/*` endpoints are disabled by default in 1.14; clients must use the MCP endpoint (the
  SDK does).

**Not shown:** generated SQL on BigQuery (step 3), cost accounting (step 4), eval parity (step 4).

## Step 2: standard tool parameters (SQLite)

**Change:** one slice tool per (metric, split concept) with an optional filter for every other concept (an empty
value restricts nothing), and one series tool per metric whose time level is a *value* (`aggregation`). A tool
reference (`m_series?aggregation=day`) carries the bound value, so runner steps keep calling `index.series(metric,
level)` unchanged; whatever executes the tool splits the reference and sends the value. Tool metadata now says what a
tool *supports* (`levels`, `filters`), and lookup matches by capability.

**Measured (contact-centre pack):** generated tools 115 -> 57. The remainder are the onboarding profile and check
tools and evidence lookups, which are unchanged; the per-metric analysis tools dropped by about 3x.

**Behaviour unchanged:** 13/13 planted-fault cases with the same number of steps per case as before, routing 27/27,
all unit tests, integration 5/5.

**Fixed along the way:** `causeline generate` could not regenerate a pack whose old sidecar no longer parsed; it now
ignores the old sidecar (`loadPack(..., { skipMeta: true })`).

**Not shown:** the new SQL on BigQuery (step 3).

## Step 3: the BigQuery dialect and pack targets

**Change:** the generator's SQL differences now live behind the `Dialect` interface (named or positional
parameters, timestamp conversion, text casts, list membership, null counts, string aggregation, timestamps as text),
with a SQLite and a BigQuery implementation and BigQuery versions of the built-in time levels and repeating cycles.
`data.yaml` names its `dialect` (default sqlite). A pack can carry a variant per database as a *target*
(`data.<target>.yaml`, `toolbox.<target>/`, `tools.meta.<target>.yaml`; `causeline generate --target`); packs made by
the Builder use the standard names and need no target. The contact-centre pack has a `bigquery` target. The BigQuery
project comes from the environment (`${CAUSELINE_BQ_PROJECT}` in the source file), so no id is stored in the repository.

**Checked against the real service (zero cost):** `node scripts/bq-dryrun.mjs packs/contact-centre --dataset
<project.dataset>` generates the BigQuery tools for a dataset and dry-runs each statement. Result: **57 of 57
statements valid** on the first run (syntax, names and types all accepted). One call of each reads about 168 MB in
total on the 120,000-row example data.

**Facts settled by direct queries:** `@end` is allowed as a parameter name; `FORMAT_TIMESTAMP('%Y-W%W', ts)` gives
the same week labels as SQLite's `strftime('%Y-W%W')` (`2026-W01`); a text timestamp with a `T` and `Z` converts back
with `TIMESTAMP()`; `%E*S` prints whole seconds when there are no fractions, so results read the same as on SQLite.

**SQLite unchanged:** regenerating the example pack leaves its generated files byte-identical; 13/13 eval cases and
all unit tests as before.

**Tests added:** golden SQL for the BigQuery dialect (named parameters all declared and used, no positional
placeholder, timestamp handling, slot filters, onboarding and evidence tools) and the target mechanism.

**Requirement stated for BigQuery packs:** a fact's time column must be a `TIMESTAMP`.

**Not shown:** that the BigQuery tools return the *same answers* as the SQLite ones (step 4 runs the 13 cases on
both and compares findings), and cost accounting.

## Step 4: BigQuery connector, parity and cost control

**What was built:** `core/connect-bigquery` (dry runs, a cost meter, plain-words explanations of Google errors, a
connection check, a dataset loader); `Result.cost` and a clean stop (`RunStop`) in the runner; a BigQuery
preparation step for evals (`packs/_lib/bigquery-prepare.mjs`, chosen with `CAUSELINE_TARGET=bigquery`, one dataset
per case); a per-case comparable `summary` in eval results; `scripts/parity.mjs` to compare two result files.

**Parity (the correctness test of the new dialect):** the 13 planted-fault cases run on SQLite and on BigQuery.
Result: **13/13 on both, and the comparison is identical**: same status, same findings in the same order, same
masking flags, headline value, baseline and change equal to 1e-9. The BigQuery run read 0.91 GB in 222 queries,
about $0.005 at list price (before the free tier).

**A silent failure found by the parity run, not by any test:** the first BigQuery run passed 11 of 13. Both failures
needed the finest time level, and the cause was that **Toolbox's BigQuery source returns only 50 rows per query
unless `maxQueryResultRows` is set**, dropping the rest without an error. The same request returned 672 rows on
SQLite and 50 on BigQuery. It also hid the `small_cells` flag for the 60 agents. Fixes: the source sets
`maxQueryResultRows: 100000`, and `withCostControl` now refuses to run on a BigQuery source whose limit is missing
or below 10,000, with a plain explanation. Any BigQuery source written later (by hand or by the Builder) must carry
the same setting; this guard is what enforces it.

**Other facts settled:** `writeMode: blocked` on the source makes Toolbox suppress every `bigquery-sql` tool as
write-capable, so it cannot be used; read-only access must come from the account's permissions. The source also
supports `maximumBytesBilled` (a hard per-query stop), now set to 20 GB.

**Cost control, live:** with the per-question limit set to 0.02 GB, a case stopped with reason `cost_budget` after 5
queries and 17 MB; the query that would have crossed the limit was not sent, and the result still reported what was
spent. The default limit is 5 GB per question (`CAUSELINE_BQ_BUDGET_GB`, 0 = none). Each tool is dry-run once and
that estimate is reused, which is exact for an unpartitioned table and an upper bound for a partitioned one.

**Not shown:** a stale-credentials message from a live failure (the explanation is unit-tested against the error
text only); cost on tables much larger than the example; the connection check wired into the MCP server (step 7).
The plugin bundle grew from 2.3 MB to 3.5 MB with the BigQuery client.

## Step 5: date-range windows in the runner

**Change:** a run can be about a range of whole days (`start_date`, `end_date`, both inclusive) instead of a period
label. `resolveWindow` (`core/runner/src/window.ts`) cuts equal-length windows from the day-level series, working
backwards from the range, and hands them to the existing `resolvePeriod` as if they were periods. Everything after
the data check (the headline, the like-for-like seasonal baseline, the drills over time and hierarchy, evidence,
products) is unchanged, because it only ever sees a `PeriodInfo`. Details that matter for correctness:
- With a weekly cycle declared, a range shorter than a week is compared with the **same weekdays** in earlier weeks
  (windows a week apart), and the node queries restrict their baseline to those weekdays; longer ranges use
  back-to-back windows. Calendar flags still pick the baseline like-for-like.
- A range must lie wholly inside the data; the stop message says what the data does cover. Backwards, malformed,
  half-given ranges and a missing period each stop with a sentence saying what to supply.
- `aggregation` names the time level to start looking at; a finer level than the default is honoured for ratios
  (one day, by half hour). Totals always start at the second level.
- The day level is the level called `day`, else the second level; the data is checked to confirm its buckets stay
  inside one day. Window and length are stated in the result's notes.
- `compare` of two periods still takes labels, and says so if given a range; a comparison of two values of one concept
  works within a range.

**Property test:** a range that is exactly one period gives the same headline, findings, masking flags and drill
path as that period's label, for a ratio, a total and a product (`range.test.ts`).

**Eval:** five new cases on the contact-centre data (a fault in one week of a two-week range; Wednesday to Friday; one
day by half hour; a clean four-week range reporting nothing; a range outside the data). **18/18 on SQLite and 18/18 on
BigQuery, and the two are identical** (1.26 GB read in 302 queries on BigQuery, about $0.007 at list price).
Routing 27/27, integration 5/5, all unit tests pass.

**Not shown / limits:** sub-day ranges; a range whose length is over a week but not a multiple of one is compared with
back-to-back windows, so the weekday mix of the node queries is slightly unbalanced (the headline is still
seasonally adjusted); trend and compare over arbitrary ranges; natural-language dates (step 6 does that, outside the
runner).

## Step 6: intent core

**Change:** a fixed structure for what a person wants, and deterministic code that checks and resolves it.
- `Intent` / `IntentPatch` / `PeriodSpec` / `ComparisonSpec` (`core/schema/src/intent.ts`). The period is data: `range`,
  `relative {unit, offset, count}`, `to_date`, `since`, `calendar {month|quarter|year, index, year?}`, `label`. An agent
  fills it from the conversation; code never parses free text. A message is a patch (left out: unchanged, null: cleared).
- `core/intent` (new package): `resolveSpec` turns a period into whole days against "today" (periods never include
  today; weeks run Monday to Sunday); `resolveAgainst` makes the other side of a comparison (previous unit, same dates a
  year earlier, or another period); `validateIntent` checks KPI (name, synonym, one clear near match, else asks),
  task, period, comparison, aggregation (a level of the ontology, "daily"/"by week" accepted, refused if the period is
  shorter than the level), every filter concept and value against the data (a near spelling is offered, never taken),
  and that the data holds the period; it returns either a ready, resolved intent with a plain-words play-back, or **one**
  question with options. `mergeIntent` applies a patch. `intentEnv` reads the data's reach, its period labels and
  concept values through the pack's own tools.
- `as_of: data_end` in `data.yaml` (set for the contact-centre sample): "today" is the day after the data's last day, so
  "last week" is the last week the data holds. Real warehouses keep the default (`today`).
- A "to date" span that begins before the data does (year to date on data that starts on 5 January) is cut to the first day
  the data holds and says so. A named month or quarter, a range and `since` a date are never cut: they ask.
- Router: `matchKpis` exported; `completeBuckets` added (labels with the days they cover).

**Checkpoint demo:** `node scripts/period-table.mjs 2026-10-14` prints the resolved natural periods (a Wednesday):
yesterday 2026-10-13; last week 10-05..10-11; last 4 weeks 09-14..10-11; last month September; last quarter Q3; year to
date 01-01..10-13; since 1 August; Q3 and Q2 in full; Q4 so far; December means last December. A second clock
(2026-01-01) shows the year boundary.

**Tests:** 16 unit tests in `core/intent` (the table above as assertions; Monday/Sunday week edges; today is never
included; a property test that consecutive "last N units" spans touch with no gap or overlap across 450 clocks and
five units; comparisons; play-back; the fixed order of questions; KPI, filter and aggregation matching; fixed-end data;
labels; patch merging) and 2 for the eval scorer, including that each kind of wrong answer is a named miss.

**Eval (fixture tier):** `packs/contact-centre/evals/intents.yaml`, 15 conversations (single messages and a five-message
build-up; topic switch keeping the rest; a filter value not in the data; a period or comparison the data cannot hold;
a view finer than the period allows), run against the pack's real clean data through Toolbox:
`causeline eval --pack packs/contact-centre --intents` gives **15/15**. The expected dates were worked out by hand from
the data's first and last day (2026-01-05 and 2026-03-15), not copied from output. Routing still 27/27; all unit tests,
purity pass.

**Not shown / limits:**
- This tier feeds the patches a model *should* make; whether a model makes them is the live tier (step 7).
- Not yet connected to a running session or the runner: `run_intent`, history and recall are step 7.
- Comparison of two periods still reaches the runner as labels (see step 5); mapping resolved windows to that is step 7.
- Weeks are Monday to Sunday; a pack whose business week differs is not yet configurable.
- Fixture eval ran on SQLite only; the lookups go through the pack's tools, so BigQuery is expected to match (step 7 runs both).
