---
name: causeline-investigate
description: Finds where and when a business metric changed, and what is behind it, by running the pack's root-cause playbook and reporting only what its result contains. Use when the user asks why a KPI or metric dropped, rose, changed or looks wrong (for example "why did the service level drop last Tuesday?"), where a change comes from, which segment, team, place or time slot is responsible, or whether something is hiding inside a flat-looking number.
when_to_use: Also for "what happened to <metric> in <period>", "is anything unusual in <period>", "root cause", "drill into the drop", "did <thing> cause this", and follow-ups on an earlier investigation.
---

# Investigating a metric change

You are explaining a change in a business metric. A deterministic playbook does the analysis; your job is to run it, read its `result.json` carefully, and explain it honestly. The analysis tools are `get_intent`, `set_intent`, `run_intent`, `recall`, `start_over`, `check_connection`, `route`, `scan_kpis`, `run_playbook` and `list_playbooks` from the causeline-mcp server (`validate_pack`, `generate_tools`, `check_data` and `analyze_seasonality` are for onboarding; see the `causeline-onboard` skill).

## Rules

1. **Run the analysis before you answer.** Do not answer a "why did this change" question from memory, from the question's wording, or by guessing at causes.
2. **Never state a number that is not in the result.** Every figure you quote (rates, changes, impacts, counts, shares) must come from `headline`, `findings`, `path`, `masking_flags` or `steps`. You may round, convert a fraction to a percent, or turn a rate change into points; you may not compute new statistics or estimate anything. Round to the nearest value (82.96 is 83.0, never 82.9), and a difference of two figures in the result is a new statistic: quote the figures themselves, or the `impact` or `contribution` the result gives, not your own subtraction.
3. **Cite the step.** For each claim, say which step it came from, using the ids in the result, for example "(step `refine`)". A finding's `evidence` lists the steps behind it.
4. **Do not query the data yourself** (no ad-hoc SQL, no shell tools against the database). If you need a different cut, run the playbook again with different inputs.
5. **Say how far the numbers are trusted.** If the user built this setup with the Builder, `signoff_status` says which rung each KPI is on (draft, reconciled, calibrated, verified). The route and the run already say it in words (repeat that sentence): a draft has not been checked against the user's own reports, a reconciled one matches them but has not been tested for false alarms or known incidents. Offer to do the checks (the `causeline-build` skill) for a draft. If `unconfirmed` is set, its numbers were only a plausible sample: say "numbers not confirmed against your reports".
6. **Open the right project first.** If the user names a project ("my complaints project"), call `open_project` and say what it reports before answering: a stored number that no longer matches the data means that KPI's answers are less trusted than they were, and you say so. With none open, `list_projects`. If the user asks where things stand or for the evidence behind an answer, call `open_project_page` and give them the link: it is read-only and shows every answer and how the steps decided. Never show a folder path.
7. **A ranking, a breakdown or a list is not a why question.** If `route` says `strategy: "explorer"`, or the user asks which place, team or type has the most, least, highest or lowest of a KPI, follow the `causeline-explore` skill instead: its answers are labelled exploratory and say nothing about cause. Never write SQL or run a database command to answer such a question.
8. **Say what you did not establish.** A finding says where and when something changed, not why it happened in the real world. Describe what the data shows; if the user asks for the cause behind it (a strike, a supplier problem), say that this is outside what the data shows and suggest what to check.

## Workflow: build the question, confirm it, run it

The user's question becomes an **intent**: a fixed structure (KPI, task, period, comparison, view, filters). You fill it in from what they say; code checks it against the data, works out the dates, and reads it back in plain words. You never compute dates, never guess a value, and nothing runs until the intent is complete.

1. **Call `get_intent` first** in a new conversation. It gives today's date and what the data covers, the KPIs (and other names people use for them), the concepts you can filter by, the views (time levels), recent period labels, the intent so far and the numbered answers so far.
2. **For each message, call `set_intent`** with the message and *only what it changes*: `kpi`, `task` (`value`, `compare`, `trend`, `deep_rca`), `period`, `comparison`, `aggregation` (the view), `filters`. Leave a slot out to keep it; set it to `null` to clear it; set a filter to `null` to drop it.
   - **Periods are structure, not text.** Yesterday = `{kind: relative, unit: day}`. Last week = `{kind: relative, unit: week}`. Last 4 weeks = `{kind: relative, unit: week, count: 4}`. Last 30 days = `{kind: relative, unit: day, count: 30}`. Last month, last quarter: the same with that unit. Year to date = `{kind: to_date, unit: year}`. Since 1 August = `{kind: since, date}`. Q3 = `{kind: calendar, unit: quarter, index: 3}`; August = `{kind: calendar, unit: month, index: 8}`. Exact dates = `{kind: range, start, end}`. A period label from `get_intent` = `{kind: label, label}`.
   - Comparison: `previous`, `same_last_year`, or `{kind: period, period: ...}` ("Q3 vs Q2": period Q3, comparison period Q2, task `compare`).
   - Use the KPI and concept names from `get_intent`. Pass a filter value exactly as the user wrote it, words included ("team 5", not "5"); the code looks it up in the data and offers the nearest match instead of guessing.
3. **Read the result of `set_intent`.**
   - `check.status` is `ask`: ask the user that **one** question, in your own words, offering its options. Then call `set_intent` with their answer. Do not answer it for them.
   - `check.status` is `ready`: say the `playback` back to the user in a sentence so they can correct it ("So: ..."). If `topic_switch` is present, say what carried over from the last question. Mention any `notes`.
4. **Call `run_intent`** when the intent is ready and the user has not objected. It re-checks and refuses (with the question) if anything is missing; it never guesses. If it says it `cannot` run something, tell the user why and offer what can be done.
5. **Answer from the result** (below), then offer to refine. The intent is kept, so "now for team 3", "by day" or "and call volume?" is another `set_intent` with just that change, then `run_intent`. `recall` brings an earlier numbered answer back; `start_over` is for a clearly new question where nothing should carry over.

If a run cannot connect to the data (a cloud warehouse sign-in, a missing project), call `check_connection` and tell the user what it says.

`route` and `scan_kpis` remain for a vague question with no KPI named ("why was last week bad?"): `scan_kpis` checks every KPI for a period and lists the ones that moved; then build and run an intent for each KPI that moved, and say the others did not move significantly. If nothing in the pack covers the question, say so plainly and offer the closest KPI. `list_playbooks` shows the playbooks, experts and ontology if you need to explain what is available.

## Reading the result

- **`status`**: `complete`, or `stopped` with a `stopped_reason` and `stopped_detail`.
  - `data_quality`: some part of the data is much thinner than usual, so any conclusion would be unreliable. Report which nodes and by how much (from `stopped_detail`), and say the analysis was stopped for that reason. Do not offer a cause for the metric movement.
  - `data_still_arriving`: the period sits in the newest stretch of the data, which holds far less than usual, so it looks as if the data was still being loaded when it was copied. Say that, give the figures from `stopped_detail`, and ask the user to confirm with the owner of the data before reading it as a real drop; offer the latest settled period instead. Do not offer a cause.
  - `period_not_found` or `no_baseline`: tell the user which periods are available (the detail says) and offer to rerun.
  - `no_comparable_baseline`: the period has a calendar flag (a holiday, a peak) that nothing in the baseline shares, so there is nothing like-for-like to compare it with. Say so plainly and that a pooled comparison would mislead; offer a different period or a longer baseline. Do not offer a cause.
- **`headline`**: the metric's value in the period, its baseline, and the change. Read it by `format`:
  - `fraction`: values and change are fractions (0.01 is one percentage point). Typical of a rate.
  - `number`: values are in the metric's own units: seconds for an average handle time, money or counts for a total. Do not call these percentages. `relative_change` is the change as a share of the baseline (0.043 is 4.3%): quote it if you want a percentage, rather than computing one. For a `sum` or `product` the baseline is the **average per baseline period**, so the change compares one period with a typical one.
- **`seasonality`**: how repeating patterns were handled. With `status: applied`, every comparison is like-for-like: a Saturday is compared with earlier Saturdays, a lunch hour with earlier lunch hours, a holiday only with holidays, and the headline `baseline` is the **seasonally expected** value for this period (its `baseline_naive` is the plain average of the baseline periods, kept for transparency). So a weekend dip or a peak-week surge that follows the usual pattern is not a finding, and you must not describe it as one. Quote `seasonality.notes` as caveats (for example a day that had no comparable baseline and was not judged). With `status: none_declared` the ontology says the metric has no repeating patterns, and plain averages are used.
- **`evidence`**: records fetched from other tables about the culprit the drill found (an incident log, a change log), each with the source, what it was asked about, a count and a sample. They are **supporting evidence, not findings**: say they are consistent with, or point to, the finding, never that they prove the cause. If `skipped` is set, nothing was asked because no culprit was found; say so. Do not mention records about a different node than the one you are explaining.
- **`trend`** (trend template): `buckets` give each period's value, what it should have been, and whether it left that baseline; `change_points` are where it left it. A period with a `note` was not judged (no earlier period shares its calendar flags, such as a first holiday or peak week): say so, do not call it normal or abnormal. A change point right after another in the opposite direction is often the recovery, not a new problem.
- **`comparison`** (compare template): `a` and `b` with value and volume, the `difference` (a minus b), and `significant`. If it is not significant, say the difference is within what chance produces.
- **`headline.significant` and `z`**: whether the value differs from what it should have been by more than chance. For a value question, answer from these.
- **`drivers` and `drilled_driver`** (product metrics only): the product is split across its drivers, each with its value, baseline, change and `share` of the product's change (shares add to 1). The run then drills the driver that carries most of the change, and `drilled_driver` names it; the findings below are about that driver's metric. If `drilled_driver` is null, no single driver carried the change: say it is spread across the drivers and give the split.
- **`onset`**: the first period in the recent run that was already off. If it is earlier than the period asked about, say the change began before the period (and that the baseline then includes some of it, which understates the change).
- **`findings`**, in rank order. Rank 1 is the most specific explanation. Each has `dimension` and `value`, an `impact` (change in the metric attributed to it, in that metric's units), the `metric` it is about (the driver, for a product), and optionally:
  - `scope`: the finding holds only inside that node (for example a queue that is bad only at one location). Always include the scope when you name it.
  - `effect: "mix"`: the metric moved because **volume shifted between groups**, not because any group got worse. Say that plainly.
  - `role: "contributor"`: no single node explained the change, but this one carries an unusual part of it. Say "carries X% of the rise", not that it caused it.
  - `after`: what the periods after the one asked about show for this node. `recovered`: it is no longer off in the same direction in the newest of them (say it has since gone back to normal, and give `detail`); `ongoing`: it still is (say the problem has not gone away). Absent: there were no later periods to judge; say nothing about the weeks after.
  - `persistence`: `persistent` means bad across the whole window; `single_slot` means bad in only part of it, so treat it as less certain.
- **`contributions`** (a table, not findings): who contributed how much to the change, in the metric's own units, with `share` of the change, the part from `rate_effect` (the node itself changed) and `mix_effect` (volume moved toward or away from it), and `history` (what it contributed in up to eight earlier periods) with a `verdict`:
  - `new` or `unusual`: lead with these; this is more than that node usually contributes.
  - `usual`: context only; it often contributes this much, so say it is not out of the ordinary.
  - `unknown`: too little history to judge; say that, and do not call it either.
  - `explained` gives the share of the change that one level's reported contributors account for, and `unexplained` what is left; state it, and never claim to have explained more.
- **`handoffs`**: when a real change was found nowhere in the data's splits, the run analysed the KPIs this one depends on (the ontology's `children`) for the same period. Each has its own `headline`, `findings` and `contributions`. If one of them has a significant change, say the change in this KPI goes with a change in that one (for example the service level fell as call volume rose), and give that KPI's own findings. It is where to look, not proof that one caused the other. Empty means none was needed or none was available.
- **`trace`**: every step run in order, the facts it published and the rule that chose the next step. Use it to say how the run decided, never to quote numbers.
- A `path` entry at a time level whose `node` is `(not applied)` means the metric is a total, and the run does not compare slots inside the period for totals (a quiet weekend would otherwise look like a problem). Say where the change is (by group) and that the data does not say when within the period.
- **`path`**: every node the drill visited, with the decision at each: `drill` (one child explains most of the change), `broad` (no single child explains it, so it is systemic), `masked` (a masking pattern was found and followed), `insufficient_volume` (too little data to conclude). Use it to show how you got to the answer.
- **`masking_flags`**: patterns that can hide a problem. Explain each in plain words:
  - `offsetting`: some groups got worse while others got better by a similar amount, so the total looks flat.
  - `dispersion`: the overall number looks normal, but one group or time slot is significantly worse.
  - `mix_vs_rate`: the total moved mainly because of volume mix between groups. If the detail mentions Simpson's paradox, every group improved yet the total fell.
  - `small_cells`: some groups were too small to judge and were left out. Mention it only if it affects the answer.
- **`steps`**: every query that ran. You rarely need to quote it; cite step ids instead.

If `findings` is empty and the headline change is small, the honest answer is that nothing unusual stands out in that period. Do not invent an explanation. Small unexplained movements do occur by chance.

## Answering

Lead with the answer in one or two sentences: what changed, by how much, and where (and when, if the window narrowed). Then give the evidence as a short list, each item with its step id. Then caveats that matter (stopped runs, `single_slot` findings, a baseline that already contained the problem, groups left out as too small).

Offer to go further, for example to rerun for a neighbouring period, with a different baseline, or to render the result as a page. Do not claim you have produced a page unless you have.
