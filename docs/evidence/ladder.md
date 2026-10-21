# The status ladder: draft, reconciled, calibrated, verified

The ladder was draft, provisional, verified. It is now **draft, reconciled, calibrated, verified**, plus a flag "numbers not confirmed". Each rung is earned by a check that has been run:

| Rung | Earned by | Can be reached today |
|---|---|---|
| draft | saved by the Builder | yes |
| reconciled | automatic checks pass, nothing flagged, and at least 3 confirmed numbers from at least 2 periods and 2 kinds, each with a named source | yes |
| calibrated | a replay over ordinary past periods stays under the false-alarm rate the person allows | **no: calibration is not built** |
| verified | calibrated, and the known incidents or planted faults it was tested on are found | **no: needs calibration first** |

An expert stands exactly where its KPI stands. Every change of rung (KPI or expert) is written to `status_log` in the build state with when, from, to, why and by which step.

## What changed, by layer (and why nothing was left behind)
- **Shared definitions** (`core/schema/src/status.ts`): the rungs, their order, the plain-words sentence for each (`statusSentence`) and what earns the next (`nextRungNeeds`). The router, the intent run, the play-back, the sign-off screen and the tool descriptions all use these, so every place says the same thing.
- **Reading old files:** an expert file without `ladder: 2` is read with the old names (verified becomes reconciled, provisional becomes draft with the flag); a build file of version 1 or 2 is upgraded on open (version 3). A KPI that was verified keeps standing as reconciled (`grandfathered`) until its formula changes; one that was provisional is a draft that needs three numbers. Each such move is logged with the step "migration". The old and new word `verified` cannot be confused because of the marker.
- **Builder** (`state.ts`, `checks.ts`, `savepack.ts`, `verify.ts`, `playback.ts`): the new rule, the log, experts synchronised to their KPI (`syncExperts`), a save that changes a KPI sends the KPI and its experts back to draft and logs it, `verify_expert` stores the incident check and no longer makes an expert verified by itself, a new `accept_sample` path for a number the person can only call plausible.
- **Router, intent, MCP tools, sign-off screen:** statuses are the new names; the announce sentence and the run notes say the rung in words; tool descriptions explain the new rule; the screen shows four rungs and the "numbers not confirmed" note.
- **Evals:** the branch-coverage gate now applies to every expert above draft.
- **Packs:** the six shipped experts are `reconciled` (with a comment for each saying why and what is still missing). The three complaints KPIs each have four confirmed numbers from two periods and three kinds; the contact-centre ones are on synthetic data, checked against totals recomputed from the files, not a person's report (said in their files).
- **Skills, README, template README, demo scripts:** reworded; the demo scripts now confirm a third number.
- **Guard:** `npm run check:ladder` (also in CI) fails if the retired name `provisional` appears outside the migration code and the history documents.

## Evidence
- Unit tests in every package pass, including: the rung rule one case at a time (one number, three numbers from one period, three of one kind, a missing source, a flagged number, a failing automatic check, no automatic run); calibration and verification cannot skip a rung; a plausible sample counts toward nothing and sets the flag, and real numbers clear it; a version 1 and a version 2 build file are upgraded with the right log entries and read back unchanged; a change drops the KPI and its expert and a re-run restores them and the log shows both; an old expert file is migrated and a new one is kept; router and intent notes carry the rung's sentence.
- `check:purity` and `check:ladder` pass.

## Not shown
- **The evals and the integration suite were not re-run after the migration.** The runs were stopped twice because the machine ran low on memory. So the contact-centre eval (25 cases), the routing eval (27), the intent eval (16) and the scripted end-to-end tests of the Builder and the MCP server (which were rewritten for the new rule: three numbers, a third one through the chat) are unproven on the new ladder, and the complaints eval on BigQuery was not re-run. The unit tests cover the logic; the end-to-end tests have been edited but not run.
- Nothing can reach `calibrated` or `verified` yet: no calibration or fault-injection code exists, so those two rungs are only defined and tested as rules.
- The sign-off screen was not opened in a browser after the change.
- The deviation from the planning note: an old `provisional` KPI is a draft **without** the "numbers not confirmed" flag. In the code, provisional meant one number genuinely matched, not a plausible sample; the flag now belongs only to numbers accepted as plausible.
