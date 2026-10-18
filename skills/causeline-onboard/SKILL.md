---
name: causeline-onboard
description: Onboards a dataset to the RCA harness: checks the data against the ontology and works out which repeating patterns (weekday, time of day, holidays, peak periods) the metrics follow, so root-cause analysis never mistakes a normal pattern for a problem. Use when the user is setting up a new pack, editing ontology.yaml, asks whether their data is seasonal or ready for analysis, or asks why weekends or lunchtimes look worse.
when_to_use: Also for "is my data OK to use", "does this metric have seasonality", "set up the ontology", "validate my pack", "why does Saturday always look bad", and before the first investigation on a new dataset.
---

# Onboarding a dataset

A metric that is always lower on Saturdays, or always dips at lunch, is not broken on a Saturday or at lunch. The harness compares every day, hour and period only with the same kind of day, hour and period, but only for the patterns the ontology **declares** in `time.seasonality`. Your job is to help the user find out which patterns their data really has, confirm them with the user, and record them. The analysis is deterministic and done by the tools; you explain and the user decides.

The tools come from the causeline-mcp server: `validate_pack`, `generate_tools`, `check_data`, `analyze_seasonality` (and `list_playbooks`, `run_playbook` for the smoke test).

## The loop

1. **`validate_pack`**. Fix errors with the user (names, hierarchies, metrics, a `min_volume` for each metric, a formula in `data.yaml` for each metric). `time.seasonality` is required: it is either the patterns found, or `none` after looking. A pack that has not looked does not validate.
2. **`generate_tools`** whenever `ontology.yaml` or `data.yaml` changed. Toolbox reloads on its own.
3. **`check_data`**. Report every `fail` and `warn` plainly, with the numbers in `detail`. A failure (a child with two parents, NULL timestamps, a zero denominator, too little history) must be fixed or explained before analysis; do not paper over it. A warning (a thin day, thin nodes) is a question for the user: is it a closure, or missing data?
4. **`analyze_seasonality`**. Read `results` (one verdict per metric and cycle), `recommended`, `declared` and `notes`, then explain them:
   - `seasonal`: the difference between positions is statistically real **and** at least `season_amplitude` of the overall level. Give the size (`amplitude`) and where it peaks and troughs, in words ("weekdays run about 7% above Sundays"). Weekday slots are 0 = Sunday .. 6 = Saturday; hours are 00..23.
   - `not_seasonal`: looked, found nothing that matters. Say so; the reason says whether there was no difference or only a trivial one.
   - `cannot_assess`: the history is too short to test this cycle (for example a yearly cycle in twelve weeks). **This is not the same as "not seasonal".** Say it was not tested, quote the count of occurrences, and tell the user what history would be needed. Never present it as a clean bill of health.
   - Calendar flags (`is_holiday`, `is_peak`) are kept even when there are too few flagged days to test, so flagged days are compared only with flagged days; a period with no comparable earlier period is reported as not judged instead of compared with ordinary days.
5. **Confirm every field with the user** before editing: which cycles, which calendar flags, and `none` if nothing was found. The tool proposes `recommended_block`; show it, explain it, and ask. Then put it under `time:` in `ontology.yaml`, run `generate_tools`, and run `validate_pack` and `check_data` again.
6. **Optional evidence**: `analyze_seasonality` with `backtest: true` replays the data's own recent periods with and without the recommendation ("without it N of M periods report something, with it K"). It is slow (minutes), so offer it rather than running it unasked. A period flagged both ways may be a real incident.
7. **Smoke test**: `run_playbook` for one metric on the latest full period, and report the result as the `causeline-investigate` skill describes.

## Rules

- **Never state a number that is not in a tool result.** Quote `amplitude`, `p`, `repeats` and counts from the result; do not estimate.
- **Do not apply a recommendation silently.** The user confirms each field.
- **Say what was not tested.** Every `cannot_assess` is reported with its reason.
- **One test per cycle, not a model.** Each cycle is tested on its own, so a strong weekday pattern can hide a smaller calendar effect; this is why calendar flags are kept when they cannot be tested. If the user asks for something the tools do not do (trend, a yearly cycle without two years of data), say it is not covered.
- Drafting the pack from a raw table is manual. `ontology.yaml` is only words (hierarchies, dimensions, KPIs with a plain description); `data.yaml` is where tables and formulas go. Ask the user for the tables, how they join, the time column and how each KPI is worked out, write both files with them, play each KPI's definition back as a sentence for them to confirm, and start the loop at step 1. There is no tool that infers them from the data.
