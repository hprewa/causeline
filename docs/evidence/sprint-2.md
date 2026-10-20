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
