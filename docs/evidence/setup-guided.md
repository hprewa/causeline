# Guided setup on the analyst's own data (Phase 1b)

Evidence for each piece, written as it is done. Plan: prep card and resumable setup; cost caps in plain words; the message to an admin and clearer sign-in; discovery that starts from a KPI; proof.

## Piece 1: the prep card and resumable setup

- `setup.json` beside the project holds what the person knows before setup: the KPI in their words, how it is worked out today, up to three numbers they trust (period, value, which report), past incidents (none is an answer), and whether they can read the data or who their admin is. It is a separate file, not part of `build.json`, so it exists before anything is connected and no stored state needed a new version.
- Tools `setup_card` (read; what is answered, the one question to ask next, the trusted numbers marked as the person's own and not confirmed checks) and `save_setup_card` (a few answers at a time; text replaces, numbers and incidents are added; the same period and report corrects rather than duplicates; a fourth number, a number without its period/value/source, and "none" alongside incidents are refused).
- `build_status` gains a leading "prep card" step once a card exists, and a `progress` line ("3 of 8 setup steps done") that `project_summary` carries, so a returning person in any client hears where they are and the next question. Without a card nothing changes for existing projects.
- The build guide starts with the card, one item at a time, and tells the assistant to offer a card number back before using it at sign-off (it stays unconfirmed until the person agrees; the ladder rule is unchanged).
- Tested: 5 builder tests (empty card, adding in turns, correction not duplication, the limits and refusals, resume through `build_status`, a hand-damaged file reported) and 1 server test through the tools; the exact tool list test is updated. All unit tests pass; purity passes.

**Not shown:** that the numbers on the card are used at sign-off by an assistant (the guide says so; no live run yet); the sign-off screen does not display the card's numbers; the card is not shown on the project page.

## Piece 2: cost caps in plain words

- `core/connect-bigquery/src/cost.ts`: bytes and money said as a person weighs them ("1.7 GB, about 1 cent"), a limit set in dollars turned into GB at list price and read back in both, and a pre-read estimate. List price ignores the free first terabyte each month, so every figure is an upper estimate.
- `cost_limit` tool: set one of dollars, GB or no limit, or read what is in force ("One question may read up to 176 GB (about $1.00 at most)", or "the standard limit; you can change it"). The limit is kept in the build record and written into the saved data definition (comments kept), and a later save keeps it over a drafted figure; a save whose deep dive would read more than the limit warns. Refused for local files and for nonsense.
- `describe_data` on BigQuery: the tables' sizes come free from their metadata; if looking could read more than 1 GB (the smaller of the tables' total and the setup budget, since large tables are sampled) it returns `needs_go_ahead` with the cost in words and reads nothing until called again with `go_ahead`.
- The build guide asks once for the limit, says the tool's sentence as it is, and tells the assistant to state a run's cost in one sentence.
- Tested: 3 cost tests (wording, dollars to GB, the go-ahead rule including unknown sizes), 2 limit tests (kept in record and yaml with comments, refusals); the exact tool list test updated. Build, unit tests and purity pass.

**Not shown:** `describe_data`'s go-ahead and `cost_limit` have not been run against real BigQuery or by a live assistant yet (piece 5); `check_setup` does not yet show the limit in force; "about 100 cents" style rounding is fixed but money for very large reads is shown to two decimals only; the free tier is ignored.

## Piece 3: the message to your administrator, and clearer sign-in

- `classifyBigQueryError` tells Google's errors apart by what to do: not signed in, expired, **cannot run queries** (the billing project lacks the right to create jobs), **cannot read the data** (the dataset lacks read), other permission, project / dataset / table not found, billing. `check_connection` now returns `problem` and `advice` when it fails. The older plain sentences keep their words; an expiry now says that some organisations require signing in every few days and that this is Google's policy.
- `access_help` writes a message the person can send as it is: the two roles (BigQuery Data Viewer on the dataset, BigQuery Job User on the billing project), the project and dataset, the account, what the access allows (reads and runs queries; nothing can be written, changed or deleted), the cost limit in force, and how it will be checked. Given a problem it asks only for the role that is missing. It never mentions scopes or tokens.
- `docs/guides/analyst-sign-in.md`: what to ask for, what each message means, and an honest account of the analyst sign-in route that is **not built**.
- Tested: 4 tests of the classification, the advice, the message and the single-role cases, 1 through the server tool. All unit tests pass.

**Not shown:** the classification is from error text and Google can word these differently; the real wording of a denied dataset read and a denied job were taken from the usual messages, not provoked on a real project; the roles named are what Google's documentation and the earlier access spike say, and were not tried against a restricted account; the OAuth-client sign-in for people without a terminal is documented as the plan, not built; no administrator has received the message.

## Piece 4: discovery that starts from one KPI

- `discover_for_kpi`, two calls. **First** (no tables): reads nothing. From the connected tables' names, columns and sizes (free metadata) it ranks the tables that fit the KPI's words, each with its reason ("its name has \"complaint\"", "a column named x matches", "it has a date column"), and offers tables that merely share a column with a match as "maybe needed", not picked. When nothing matches it says so and offers every table. **Second** (the tables the user confirmed): after a go-ahead if looking could read more than 1 GB, it profiles **only those tables** through the existing profile (not the whole dataset) and returns a draft in sentences (what is counted, over which dates, broken down by what, numbers, yes/no columns, nested levels, links and unmatched rows), the risks seen and the questions to ask.
- Risks, all deterministic and each phrased as a question for the person: rows with values like test, cancelled, void, duplicate (from the few sample values the profile keeps, so absence is not proof); a rate-like column that runs 0 to 1 or 0 to 100 (fraction or percent?); a date column empty on some rows; **data still arriving** (the newest day or two far thinner than a typical day, from one query over the date column, refused cleanly if it would read too much); several date columns and unmatched join rows (already flagged before).
- Matching is plain word matching with a simple plural rule, so it is explainable and testable; no model call is inside the tool. The assistant does the talking.
- Tested: 6 tests of word matching, ranking, related tables, no-match and stop-word cases, each risk with clean values raising nothing, the late-arrival rule with its edge cases, and the draft sentences; the exact tool list test updated. All unit tests and purity pass.

**Not shown:** it has not run on real BigQuery yet (piece 5); matching will miss a KPI named in words that do not appear in any table or column name (then the person sees every table and chooses); a table whose KPI words are in its *values* rather than its names will not match; "test" rows are found only if they appear among the few sample values; the late-arrival rule assumes daily data; no live assistant has used it.

## Piece 5: proof on real BigQuery, and the regression

- **A scripted guided setup on the public CFPB dataset** (`scripts/setup-proof.mjs`, billed to `yukti-dev`), through the real MCP server over stdio, in two sessions sharing one Causeline folder: **all checks passed**. A new project is made; the prep card is filled in turns and the next question moves on; the whole dataset is connected (nothing read: 2.3 GB of tables described); the standard limit is said in words ("up to 5 GB, about 3 cents at most"); a limit set as $1 reads back as 176 GB and "$1.00"; `discover_for_kpi` for "complaint volume" reads nothing and puts the complaints table first with its reasons; naming that table asks for a go-ahead first (2.3 GB is over the 1 GB line) and reads nothing until given; looking at only that table gives a draft in sentences (3,458,906 rows, several date columns so it asks which, breakdowns, yes/no columns) and two things to check; the message to an administrator names both roles and the limit chosen; the connection check passes; and a **second session** opens the project and says "2 of 7 setup steps done" with the next question, the card's answers and the chosen limit intact.
- What looking read varied between runs (1.71 GB, then 0.13 GB, as BigQuery served part of it from its cache); the go-ahead estimate is the upper bound, not a promise.
- **Two defects found by that run and fixed:** `check_connection` needed a saved description and so failed for a project still being set up (it now checks what the project was connected with); and it looked for the dataset in the billing project, so it failed for data that lives in another project (an existing fault, also for finished packs; it now reads `project.dataset`). The late-arrival risk now names its date column, and the summary line counts the questions as well as the risks.
- **Regression on this machine after all four pieces:** build and all unit tests pass (builder 62, connect-bigquery 21, mcp-server 47); purity and ladder-name guards pass; contact-centre 25/25; routing 38/38; intents 16/16; integration 8/8; **complaints on BigQuery 7/7**; the plugin, the Claude Desktop extension and the single executable were rebuilt: the extension run per its manifest passed (130 s, including the real 294 MB fetch) and the executable run with no Node on the PATH passed (143 s).

**Not shown**
- **No live assistant has run the guided setup** (the guide changes are untested with a model); the script plays the model. A live run is the next thing to do.
- No real analyst, no organisation with a restrictive policy, no administrator who received the message.
- The analyst sign-in without a terminal (a user-created OAuth client) is documented, not built.
- `check_setup` does not yet show the cost limit in force.
- The discovery matching is by names and columns only; the late-arrival check assumes daily data; only the public dataset was tried.
- Still nothing run inside real Claude Desktop or Codex, on macOS or Linux; files unsigned.

## A live Claude Code run of the guided setup (complaints, real BigQuery)

`scripts/build-conversation.mjs` with a new persona (`packs/complaints/evals/setup-persona.md`: a non-technical analyst who knows one KPI, one trusted number, one incident, and is fine with about a dollar a question). A Claude Code assistant with the plugin, a fresh Causeline folder, 14 turns, **$0.85 for the assistant** and $0.37 for the simulated user. Transcript: `runs/build-conversation-2026-10-22T20-05-20-788Z.json` (not committed). One run, so this is an observation, not a rate.

**What the assistant did well**
- It opened with `list_projects`, `get_guide` and `setup_card`, asked for a project name, and then asked the prep-card questions **one at a time**, saving each answer as it came (`save_setup_card` on the KPI and how it is worked out, the trusted number with its source, the incident).
- It said what looking at the data would read (up to 2.3 GB, about a cent) and **waited for the go-ahead** before reading, then told the person it had read 128 MB.
- It spoke in plain words throughout (no SQL, no paths, no tool names shown); read the saved description back as numbered sentences; asked for the person's own number before showing its own; and when its count (17,860) was far from theirs (26,270) it reported the gap, gave a plausible reason (the snapshot ends days after that week), and offered an older week, then labelled the KPI a draft with unconfirmed numbers when none was available. It did not invent a number.

**What it did not do, against the guide**
- **It never asked about a cost limit** (`cost_limit` was not called) although the guide says to ask once, early. The person was never offered a limit to set.
- **It did not use `discover_for_kpi`.** The dataset has a single table, so a shortlist had nothing to choose between and calling `describe_data` directly was reasonable, but the shortlist path (which was the point of the piece) was not exercised by a model. A dataset with several tables is needed to test it.
- It recorded **read access as confirmed** from "I'm already signed in" without asking the access question; the sign-in was not checked with `check_connection` at that point.
- `access_help` was not needed and not used.

**Conclusion:** the prep card and the go-ahead work with a live assistant; the cost-limit instruction was ignored and the KPI-shortlist path is untested with a model. Next: make the cost-limit step part of the flow the assistant cannot skip (for example, have `describe_data` and `connect_bigquery` say the limit in force and offer to change it), and run again on a multi-table dataset.
