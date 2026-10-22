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

## Step 3: routing: rankings, top lists and breakdowns go to the Explorer

**What was built**
- `core/router/src/explore-shape.ts`: a question that names a KPI and asks for a ranking ("which ... had the highest/lowest/most/least ..."; "worst" and "best" read through the KPI's own direction, so the worst of a higher-is-better KPI is its lowest), a top or bottom list ("top 5", "bottom three"), "rank", or a breakdown by a concept the pack has ("by", "per", "each", "break down") is routed to the Explorer. The route carries the KPI and a first read as a hint (`op`, `by`, `order`, `top`, `period`) and an announcement that says no expert covers it and the answer is exploratory. A "why" question is never taken, and neither is a question the router already reads as a comparison or a trend; a time word ("the most recent week") is not a concept, so it is not a ranking.
- The routing eval can check the KPI, the suggested first read and the period of an explorer route (`expect.op`).

**Evidence**
- 4 new router tests over a neutral vocabulary: nine ranking, top-list and breakdown questions each route to the Explorer with exactly the inputs expected (including "worst" read both ways by direction); seven look-alikes that an expert covers stay with the expert (a why question about the lowest zone, a plain value, a trend by zone, a comparison, "the most recent week"); the shape rules; a question with no KPI still goes to the Explorer with none named.
- Contact-centre routing eval **38/38** (the 27 earlier cases unchanged, 8 explorer cases and 3 look-alikes added); intents 16/16; all unit tests pass; purity passes.

**Not shown**
- The shape is read from words: a ranking asked in other words ("what is the busiest ...", "who is doing worst") is only caught when it uses one of the listed words and names a concept. A question that misses goes where it went before (an expert's value answer), not to a wrong place.
- Only the contact-centre pack has routing cases for this; the complaints pack has no routing eval.

## Step 4: the page for explorations

**What was built**
- The local pages gain **Explorations** (in the menu, after "How it decides"): a list newest first (the question, how many steps, how many requests were refused, whether it stopped at its limit) and one page per exploration: an "Exploratory" banner with the sentence about itself, the KPIs read with how far each is trusted in words ("not yet checked against your reports" for a draft), then every step (what was asked, the sentence, the rows as a table, how many were found and shown, notes, a refusal with its reason and what to do instead, queries and data read), the budget used, and why it stopped.
- Same rules as the other pages: built on the server with every value escaped, no script, no form, no button, a policy that allows none; only a plain exploration file name inside the project's results folder is read; a file that is not a valid exploration is not listed and not opened. Explorations are not mixed into the Results list.

**Evidence**
- 2 new tests over HTTP (23 in the package): the list and the page show the question with its markup escaped, the refusal count, the trust in the KPI read, numbers to four places, "5 found; 1 shown", the notes, the refusal (reason and alternative), the budget used and a hostile value shown as text; a file that is not an exploration is not listed; seven path tricks (`..%2F`, encoded dots, a result file, a bad file, a missing file, a slash inside the name) all say "cannot be shown" and never return the file outside the folder. The earlier "no script, no form, no button" test now covers the two new pages.
- Pictures in a real browser, light and dark, of a real exploration made by the previous step's run (the planted-fault data): `docs/evidence/explorer/`. Looking at them found one wording bug (the banner said "This comes from it comes from"), fixed.
- All unit tests pass in every package; purity passes.

**Not shown**
- The pages were not opened by a live assistant; the pictures are of the same page code over the stored record of a scripted run.
- Long explorations (12 steps of 25 rows) were not pictured.

## Step 5: the skill, the guardrail and the README

**What was built**
- `skills/causeline-explore/SKILL.md`: when to use the Explorer (route says explorer, or a ranking, a breakdown, a list, a figure that is a read rather than a reason), eight rules (every answer says it is exploratory; quote only numbers from `rows`; never write or suggest SQL or read the data another way; no claim about cause; say how far the numbers are trusted; say what was left out; respect the limits; never invent a value for a filter), how to chain the operations, when it is the wrong tool, and "a refusal is an answer". The `causeline-investigate` skill points to it ("a ranking, a breakdown or a list is not a why question") and the server's instructions to the model name it.
- `clients/claude-code/hooks/guard.mjs` and `hooks.json` (the plugin's `PreToolUse` hook for Bash and PowerShell): a pure matcher that refuses the common side doors to the data, each with the rule that caught it and what to do instead: the BigQuery command line, a database command line (sqlite, duckdb, psql, mysql ...), starting Toolbox by hand, Toolbox's own endpoint, reading a database file, and an inline script that opens a database. Words in quoted text (a commit message that mentions sqlite) are not matched. A hook it cannot read the input of stays out of the way.
- README: the Explorer in the end-user path.

**Evidence**
- 4 hook tests: thirteen side-door commands are blocked, each by the expected rule and with the pointer to `explore`; eleven ordinary commands (and mentions of these words in text, a script called `toolbox.mjs`, a directory called `toolbox/`) are not; the answer is in the form Claude Code reads (`permissionDecision: "deny"` with a reason), checked also by running the script as Claude Code does; the plugin registers the hook, and every rule has a case.
- A test that the explore skill names the tool and each operation, carries the label, forbids SQL and no claim about cause; that every tool it names exists; that the investigate skill and the server's instructions point to it.
- All unit tests pass in every package; purity and the ladder guard pass.

**Not shown**
- **The hook is a guardrail, not a boundary**, and says so in its first lines: a determined command can be written that none of the patterns catch. The boundary is that the tools offer no free query and that the person's own database role is read-only. On Claude Desktop and Codex the hook does not apply (the Codex `PreToolUse` equivalent is a packaging step not built).
- The hook has not been installed into a live Claude Code and tried against a model that is trying to go round the tools (step 6 runs the live assistant, which does not try to).

## Step 6: proof (partly done)

**Built and tested**
- Agent-level scoring for Explorer questions (`explorer` in an eval case's expectation): the assistant used the `explore` tool; said the answer is exploratory, and the tool labelled it; the rows hold the words wanted (a node, a date); a refusal of the right kind when one is due; no shell command or database tool of its own; every number it quoted is in the rows or the question (in percentage form too). The stream parser keeps what each `explore` call answered. Cases can live in another file (`--cases explorer`) and an agent-only case no longer fails a runner-level run.
- Five questions in `packs/contact-centre/evals/explorer.yaml`: the worst team in week 7, calls by queue, the three busiest agents, one team day by day, and a request to run SQL (must be refused with the pointer to the Builder).
- 6 tests of the scoring: a good answer passes; each way to go wrong (no label, a number not in the rows, the tool's label missing, a node missing, the tool not used, a shell command) is caught on its own; a refusal is scored on what the tool said; numbers are traced; the parser; the cases load.

**Not shown (the run was stopped: the machine ran out of memory)**
- **The live assistant has not been run on the five questions**, so nothing is shown yet about whether it reads the data only through the tool, says exploratory, quotes only rows, and refuses SQL.
- **SQLite against BigQuery parity of the Explorer's rows, and its cost per question on BigQuery**, were not run.
- The complaints eval, the contact-centre eval, routing and intents were not re-run after the Explorer (routing was, after step 3: 38/38).

