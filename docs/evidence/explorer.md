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

## Step 2: the `explore` tool and the stored exploration, on real data

**What was built**
- `core/mcp-server/src/explore.ts`: the `explore` tool. One call is one fixed read; the first call of a question carries the question, later calls continue the same exploration, and `new` starts another. The record is written to the project's results folder after every step (`exploration-<id>.json`), so a conversation that stops loses nothing and a page can show one under way. Switching project clears the exploration.
- Every result carries `label: "exploratory"` and the sentence about itself, the rows, notes, what was read (queries, bytes on a database that reports them), the KPIs read with how far each is trusted, and the budget left. A request that cannot be done is an answer (`refused`, with a reason and what to do instead), not an error.
- The tool's description tells the assistant: say it is exploratory, quote only numbers from `rows`, never work out new ones, make no claim about cause, report `refused` in plain words.
- A pack can set its own budgets in `ontology.yaml` (`explorer: { max_steps, max_rows }`).

**Evidence** (a scripted run through the server over stdio against a real Toolbox and the contact-centre data with a planted fault, with every number recomputed here from the raw CSV files, not by the system under test)
- The worst teams by service level in week 7: team_05 first, its value and row count equal the CSV's (to the six decimals the tool reports); calls by queue in week 7: every volume is the CSV's count and they add up to the week's total; one team's service level by day for seven whole days: each day equals the CSV; two teams side by side: the numbers match and the difference is reported as real; the biggest fall against the week before: team_05, as the fault. The same exploration continued across the calls and `new` started another.
- A free-SQL request is refused with the reason and "describe it as a KPI with the Builder"; an unknown KPI is refused with the list of KPIs; a filter value that does not exist returns no rows. The stored record validates, is labelled exploratory, numbers its eight steps, keeps the question, and holds the two refusals.
- All unit tests pass in every package; purity passes. Found on the way: the results page's ordering depended on file times that tie when two files are written together, so it could list the older first; it now settles a tie by the file name, and its test sets the times.

**Not shown**
- Not run on BigQuery (step 6). `profile` has not been run against real data.
- The record's `queries` and bytes are zero on a database that does not report them (SQLite).
- The router does not send questions here yet (step 3), and nothing on a page shows an exploration yet (step 4).

