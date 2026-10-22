# Guided setup on the analyst's own data (Phase 1b)

Evidence for each piece, written as it is done. Plan: prep card and resumable setup; cost caps in plain words; the message to an admin and clearer sign-in; discovery that starts from a KPI; proof.

## Piece 1: the prep card and resumable setup

- `setup.json` beside the project holds what the person knows before setup: the KPI in their words, how it is worked out today, up to three numbers they trust (period, value, which report), past incidents (none is an answer), and whether they can read the data or who their admin is. It is a separate file, not part of `build.json`, so it exists before anything is connected and no stored state needed a new version.
- Tools `setup_card` (read; what is answered, the one question to ask next, the trusted numbers marked as the person's own and not confirmed checks) and `save_setup_card` (a few answers at a time; text replaces, numbers and incidents are added; the same period and report corrects rather than duplicates; a fourth number, a number without its period/value/source, and "none" alongside incidents are refused).
- `build_status` gains a leading "prep card" step once a card exists, and a `progress` line ("3 of 8 setup steps done") that `project_summary` carries, so a returning person in any client hears where they are and the next question. Without a card nothing changes for existing projects.
- The build guide starts with the card, one item at a time, and tells the assistant to offer a card number back before using it at sign-off (it stays unconfirmed until the person agrees; the ladder rule is unchanged).
- Tested: 5 builder tests (empty card, adding in turns, correction not duplication, the limits and refusals, resume through `build_status`, a hand-damaged file reported) and 1 server test through the tools; the exact tool list test is updated. All unit tests pass; purity passes.

**Not shown:** that the numbers on the card are used at sign-off by an assistant (the guide says so; no live run yet); the sign-off screen does not display the card's numbers; the card is not shown on the project page.
