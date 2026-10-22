# The Explorer: questions no expert covers, answered from fixed reads and labelled exploratory

Plan: a closed set of read operations over the project's own catalogue tools; no free SQL; two budgets enforced by the server; every answer labelled exploratory; a record and a page for every exploration; a refusal with an alternative for what it cannot do.

## Step 1: the operations, the refusals, the budgets and the record

**What was built**
- `core/runner/src/explore.ts`: the `Explorer`. Operations `breakdown` (a KPI split by one concept, optionally inside filters), `rank` (highest, lowest, biggest rise, biggest fall, against a second window), `series` (a KPI over time for whole days), `compare` (two values of a concept, or two windows, with whether the difference is real: the same `zScore`/`zSum` as the compare playbook), `profile` (a KPI by position in a cycle) and `cannot` (records a standard refusal). All go through `ToolIndex` and `ToolCaller`, the path the playbooks use, so the BigQuery byte budget applies unchanged. Nothing takes SQL, a table, a column or an expression; a KPI, a concept, a time level and a cycle must be ones the ontology names; a filter value is passed to a tool as a bound value.
- Groups under the KPI's `min_volume` are not ranked and are listed apart. A filter value that matches nothing returns the values that do exist, never a guess. A product KPI is refused with its parts named. Dates are checked (format, order, inside the data).
- Two budgets, enforced here: 12 steps and 400 rows returned (a pack can change them). Past either the exploration ends with a stated reason and stays ended; a refusal does not use a step; rows past the budget are cut with a note saying how many.
- `core/schema/src/exploration.ts`: the stored record: the question, a step per call (what was asked in words, the arguments, one plain sentence, the rows, notes, queries, bytes, milliseconds, a refusal if there was one), the KPIs read with their rung, the budget used, and why it stopped. Always `label: "exploratory"`.

**Evidence**
- 10 tests over the neutral test domain with a planted fault: a breakdown (every value, volumes add up, shares add to one, the fault shows), a ranking at each end and by change against another window (and refusing a change without a second window), a filter (rows confined; a hostile value `x'; DROP TABLE facts; --` is only a value and matches nothing, and the values that exist are listed), thin groups not ranked, a series over whole days for one filter, comparisons of two values and two windows (real and not real), nine refusals each with a reason and what to do instead, every standard refusal kind, both budgets and a refusal costing no step, and the record validating as a stored exploration.
- All runner tests pass (164); the purity guard passes.

**Not shown**
- Nothing here has run against a real database or through the MCP server (steps 2 and 6). The `profile` operation is tested only for its refusal: the test fake cannot answer the cycle tools.
- The refusal for free SQL and joins is a recorded request (`cannot`), made by the assistant; the code cannot tell a person is asking for SQL in words. The boundary that matters is that no operation accepts any.
