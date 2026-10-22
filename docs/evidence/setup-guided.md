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
