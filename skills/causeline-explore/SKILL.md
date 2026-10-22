---
name: causeline-explore
description: Answers a question about the user's KPIs that no expert covers, by reading the data in fixed ways (a ranking, a top or bottom list, a breakdown by a concept, a KPI over time, a comparison of two values or two periods, a pattern over a cycle), and labels every answer exploratory. Use when route says strategy "explorer", or when the user asks which place, person, group or type has the highest, lowest, most or least of a KPI, asks for a breakdown or a list, or asks for a figure that is a read of the data rather than a reason for a change.
when_to_use: Also for "which team had the worst ...", "top 5 ... by ...", "show ... by ...", "break down ...", "rank the ...", "how does X compare with Y" when the analysis does not cover it, and any request that sounds like a database query.
---

# Exploring: questions no expert covers

You answer from **fixed reads of the project's own data**, one step at a time, with the `explore` tool. It is not a database: it cannot run a query, join other data, say what caused something, or change anything. Every answer is **exploratory**, and you say so.

## Rules

1. **Every answer uses the word "exploratory"**: say that the answer is exploratory, that it comes from a fixed read of their data, not from a checked expert, and that it says nothing about cause. The tool gives you the sentence (`about_this_answer`); say it, shortened if you like, but never leave out the word.
2. **Quote only numbers from `rows`.** Do not add, subtract, average, rank or round differently from what the rows give; if a figure is not there, run another step or say it is not available. A difference between two rows is a new statistic: quote the two figures, or run `compare`, which gives the difference and whether it is real. So "billing got 2,854 and general 3,037" is fine, and "a difference of 183 calls" is not; a total or a share is fine only if a row or `says` gives it. Do not summarise rows as a range or an average either ("160 to 190 on weekdays", "about 79%"): name the rows. A ranking's `gap_to_next` column gives how far each is from the next one; quote that rather than subtracting.
3. **Never write or suggest SQL, and never read the data any other way.** Do not run shell commands against a database, a CLI for one, or the data files; the data is read only through the tools. If the user asks for "a query", call `explore` with `op: "cannot"` and `kind: "free_sql"`, then tell them what it says to do instead.
4. **No claim about cause.** "Team 5 had the lowest service level" is a reading. "Team 5 is understaffed" is a cause. If the user wants to know why, that is a question for the analysis: route it (`route`, then the investigate skill).
5. **Say how far the numbers are trusted.** `trust` lists each KPI read and its rung. For a draft KPI say its numbers have not been checked against the user's own reports. Do not mention it for a verified one.
6. **Say what was left out.** `notes` tell you when small groups were not ranked, when rows were cut, when windows differ in length. Say so when it changes how the answer reads.
7. **Respect the limits.** One question is at most 12 steps and 400 rows. If `stopped` is set, say what was found so far and that the exploration ended at its limit; do not start a new one to get round it unless the user asks something new.
8. **Never invent a value for a filter or a name.** If a value matches nothing, the answer lists the values that exist: offer them.

## How

1. **Start from `route`.** For `strategy: "explorer"` the first option's `inputs` suggest the first read (`op`, `by`, `order`, `top`, `period`). It is a hint: choose the operation that answers the question. If no KPI is named, ask which of the project's KPIs is meant (`list_playbooks` lists them), one question.
2. **Say what you are about to read** in one sentence before you read it, so the user can redirect.
3. **Call `explore`.** The first step of a question carries `question` (their words); later steps continue it; use `new: true` when the subject changes.
   - `breakdown`: a KPI by one concept, optionally inside `filters` (`{concept: value}`).
   - `rank`: the highest or lowest values of a concept, or the biggest rise or fall against a second window (`against_period` or `against_start`/`against_end`). Groups too small to rank are listed apart.
   - `series`: a KPI over time for whole days (`start_date`, `end_date`), at a time `level`.
   - `compare`: two values of a concept (`nodes`), or two windows.
   - `profile`: a KPI by position in a cycle, such as the weekday.
   - `cannot`: record a request the tool cannot do (`free_sql`, `join`, `cause`, `change`, `unknown_kpi`, `other`); it gives the reason and what to do instead.
4. **Answer in plain words**: lead with the answer in one or two sentences, then a short list or table from `rows`, then the label and any note that matters. Offer the next read, or the analysis if they now want to know why.
5. **Show the evidence on request.** If the user wants to see what was read, call `open_project_page`: the Explorations page shows every step and its rows. Do not show file names or paths.

## When it is the wrong tool

- "Why did X change?": the analysis (investigate skill).
- "What was X in week 5?", "How is X trending?", "Compare week 7 with week 6": the experts already cover these (`route` says so).
- A figure the project does not define: say so, and offer to describe it as a KPI with the Builder, which checks it against the user's own reports.
- A question about the world rather than the data: say you can only read the project's data.

## A refusal is an answer

When `refused` is set, tell the user in plain words why, then what they can do instead, using what the tool says. Do not apologise at length, do not try the same thing another way, and do not offer to "work around" it.
