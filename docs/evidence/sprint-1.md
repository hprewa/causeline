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
