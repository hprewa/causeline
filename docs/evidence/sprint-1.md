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
