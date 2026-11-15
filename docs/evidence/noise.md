# Noise: every known failure as a tracked test (build guide, Phase 0)

The build guide (`docs/BUILD_GUIDE.md`) lists nine defects found by an independent run in November 2026. Phase 0 fixes none of
them. It turns each one into a case that fails today and is tracked by name, so that a later fix can be seen to work and cannot
quietly break something else. This page is the measured starting point. Phase 2 adds its diagnosis and its before-and-after
numbers below.

Nothing in the analysis changed in this phase. The only edits to `core/` are a reworded sentence, a `gap` marker for routing
cases, and two skipped tests.

## What was added

| Defect | Where it is tracked | Run it with |
|---|---|---|
| D1 false alarms when rates wobble | `packs/contact-centre/evals/noise.yaml` part 1 (86 quiet weeks) and `packs/deliveries/evals/cases.yaml` (7 quiet weeks) | `npm run eval:noise`, `npm run eval:deliveries` |
| D1 and D2 a real fault on top of the wobble | `noise.yaml` part 2 (30 cases) | `npm run eval:noise` |
| D2 planted faults not found on noisy data | `scripts/deliveries-inject.mjs` | `node scripts/deliveries-inject.mjs --sizes 4,6` |
| D3 no finding for a combination | `packs/deliveries/evals/cases.yaml`, `planted_week_names_the_combination` | `npm run eval:deliveries` |
| D4 a small unit is missed | `noise.yaml` part 3 (10 cases) | `npm run eval:noise` |
| D6 router | five questions at the end of `packs/contact-centre/evals/routing.yaml` | `node core/cli/dist/src/main.js eval --pack packs/contact-centre --routing` |
| D7 short history said too late | skipped test in `core/builder/test/calibrate.test.ts` | `npm test` |
| D8 overlapping periods count twice | skipped test in `core/builder/test/checks.test.ts` | `npm test` |
| The rate table | `scripts/noise-rates.mjs`, `scripts/rates.mjs --null noisy-rate` | `node scripts/noise-rates.mjs` |
| Nightly run | `.github/workflows/nightly.yml` | 03:17 UTC, or by hand |

D5 (a number the assistant worked out itself) and D9 are not in this phase: D5 needs a live assistant and belongs to Phase 1,
D9 to Phase 5.

A case marked `gap` is expected to fail today. A failing gap is reported by name and does not fail the run. A gap that starts
to pass does fail the run, with "GAP CLOSED", so the marker has to be taken off in the same commit as the fix.

## D1: false alarms when rates wobble

The data is the contact-centre generator with `noisy_rate`: each week, every team (or every queue) has its service level moved
by its own random amount. Nothing is planted, so anything raised is a false alarm.

### The rate table

`node scripts/noise-rates.mjs --levels 0,0.01,0.02,0.03 --seeds 4 --sizes 4,6`. Four seeds of 30 weeks for each level; each
seed's last 25 weeks are judged, one after another, against the weeks before. The wobble is by team; the KPI is service level.
Data: `docs/evidence/data/noise-rates.json`.

| Wobble (sd of each team's weekly move) | Quiet weeks judged | Raised something | False-alarm rate | 95% interval | Planted faults found at 4 standard errors | At 6 standard errors |
|---|---|---|---|---|---|---|
| 0 | 100 | 1 | 1.0% | 0.2% to 5.4% | 10 of 12 | 12 of 12 |
| 0.01 | 100 | 5 | 5.0% | 2.2% to 11.2% | 8 of 12 | 10 of 12 |
| 0.02 | 100 | 6 | 6.0% | 2.8% to 12.5% | 8 of 12 | 10 of 12 |
| 0.03 | 100 | 12 | 12.0% | 7.0% to 19.8% | 5 of 12 | 10 of 12 |

The false-alarm rate rises with the wobble and detection falls with it. The standard is one in twenty.

### The same thing measured three ways gives three numbers

| How it was measured | Result at wobble 0.02, service level |
|---|---|
| The guide's six seeds (21 to 26), week 6, by team | 5 of 6 raise something (only seed 23 is quiet). This reproduces the independent run exactly. |
| Twenty new seeds (301 to 320), week 6, by team | 5 of 20 |
| Twenty new seeds, week 6, by queue | 3 of 20 |
| The rate table above: 25 weeks from each of 4 seeds, by team | 6 of 100 |

These do not agree, and Phase 0 does not explain why. 5 of 6 against 5 of 20 is unlikely to be chance alone (about 1 in 50 if
both were draws from one rate), so either seeds 21 to 26 are an unlucky run or something about them differs. The rate table
judges the last 25 of 30 weeks, most with a longer history than week 6 has, which may be why it is lower again (not tested). The honest reading
today: somewhere between 6% and 83% depending on the seeds and the week, and above the standard on every measure. Working out
which is the first task of Phase 2.

Handle time in the same data (the wobble moves service level, not handle time): 0 of 40 raise anything.

### Quiet weeks in the delivery data

`packs/deliveries` has a weekly wobble of 1.2 points for each warehouse. Of the seven weeks with nothing planted, one (W30)
raises a finding. The calibration replay in `scripts/deliveries-inject.mjs` (data with no fault at all) flags the same week:
1 of 8. W30 is marked `gap`; the case was not rewritten and the data was not regenerated to avoid it.

## D1 and D2: a real fault on top of the wobble

Thirty cases, wobble 0.02 by team and by queue, five seeds each (401 to 405).

| Fault planted | Found |
|---|---|
| One team understaffed for a week | 10 of 10 |
| One team's calls 1.5 times as long for a week | 10 of 10 |
| A two-hour outage on one day, with the week's headline normal | 3 of 10 |

The outage is the fault that depends on a claim inside a flat whole, which is where the wobble does its damage.

## D2: planted faults on the delivery data

`node scripts/deliveries-inject.mjs --seed 5 --sizes 4,6`: delivery data with no fault (seed 42), an expert built from the
files and reconciled, a calibration replay, then faults planted in a copy. Data: `docs/evidence/data/deliveries-inject.json`.

| Fault | At 4 standard errors | At 6 standard errors |
|---|---|---|
| One warehouse gets worse | missed | missed |
| One warehouse worse while another gets better | missed | missed |
| The mix moves towards the worst warehouse | missed | found |
| One warehouse's rows do not arrive | declined, as it should | declined, as it should |
| Total | 1 of 4 | 2 of 4 |

The planted shift at "6 standard errors" swaps 79 of 2,044 rows in one warehouse, which is about 4 points of on-time rate, and
moved the headline by 0.7 standard errors. So the planter's size and the size the analysis sees are not the same unit. The
guide names this (Phase 2, the planter in the detector's units). The independent run reported 1 of 3; this run plants four
kinds and finds 1 of 4 at the smaller size.

## D3: a cause that is one carrier at one warehouse

Week 2026-W31 has carrier_b at wh_east 30 points worse. The analysis names wh_east and names carrier_b, as two findings; it
does not name the combination. `planted_week_names_both_halves` passes; `planted_week_names_the_combination` is the gap.

## D4: one agent's bad week

One agent answers 15 points fewer calls in time for one week, seeds 201 to 210: found in 4 of 10, missed in 6. The six misses
are marked `gap`; the four that pass are ordinary cases and now guard against a fix for D1 losing them.

## D6: the router

Five new questions, all routed wrongly today: "are calls taking longer than usual?" (matched on "calls"), a paraphrase with
none of the KPI's words, two typos in a KPI's name, a date written out, and "last Tuesday". The 38 existing questions still
pass. Routing cases can now carry a `gap` marker; the score counts ordinary cases only and a gap that passes fails the run.
A question that names a value to filter by is not there: the routing case has no field for it yet (Phase 5).

## D7 and D8

Two unit tests state the wanted behaviour and are skipped with the reason in their name, so `npm test` lists them on every run:
a history too short to calibrate should be said before the replay with the number of periods still needed (D7); a day inside a
week already reconciled should not count as a second period (D8).

## The loader

`packs/_lib/synthetic-prepare.mjs` loads the generated files with Python's own SQLite when the DuckDB program is missing, or
when `CAUSELINE_LOADER=python` is set. The contact-centre eval gives the same 25 of 25 through it. The nightly workflow uses it.

## Phase 2, step 1: what raises the false alarms (diagnosis, nothing changed)

All 13 quiet weeks of the noise suite that raise something were run again and taken apart (15 November, committed code).
The first columns are what the analysis reported. The last four were worked out separately, straight from each case's data:
the reported part's move in week 6 against the average of weeks 2 to 5, that move in units of counting noise alone, the part's
own week-to-week spread over weeks 1 to 5, and the move in units of that spread. Data: `docs/evidence/data/noise-diagnosis.json`.

| Case | Headline z | Headline called significant | Part reported | Its move (points) | z on counting noise | Its own spread (points) | z on its own spread | The whole's own spread (points) |
|---|---|---|---|---|---|---|---|---|
| `team_s301` | 3.71 | yes | centre=cc_2 | +2.3 | 4.18 | 0.3 | 7.09 | 0.19 |
| `team_s302` | 2.23 | yes | centre=cc_1 | +2.0 | 3.59 | 0.6 | 2.85 | 0.40 |
| `team_s312` | -0.6 | no | site=s_2 | -3.5 | -4.26 | 0.4 | -7.01 | 0.60 |
| `team_s318` | -0.65 | no | team=team_08 | -6.9 | -5.29 | 1.7 | -3.62 | 0.86 |
| `team_s320` | 3.24 | yes | centre=cc_2 | +2.9 | 5.19 | 0.9 | 2.76 | 0.31 |
| `queue_s305` | -0.8 | no | queue=sales | -5.7 | -7.4 | 1.9 | -2.67 | 0.72 |
| `queue_s314` | 0.24 | no | queue=sales | -4.7 | -5.83 | 1.5 | -2.85 | 0.93 |
| `queue_s318` | 0.79 | no | queue=billing | -3.1 | -4.04 | 1.9 | -1.47 | 0.36 |
| `team_guide_s21` | -1.61 | no | team=team_03 | -5.5 | -4.15 | 2.8 | -1.77 | 0.34 |
| `team_guide_s22` | -0.95 | no | team=team_09 | -7.1 | -5.59 | 3.5 | -1.81 | 0.75 |
| `team_guide_s24` | -0.42 | no | team=team_09 | -7.0 | -4.98 | 1.1 | -5.91 | 0.49 |
| `team_guide_s25` | -2.34 | yes | team=team_03 | -6.3 | -4.85 | 2.0 | -2.85 | 0.14 |
| `team_guide_s26` | -0.29 | no | agent=agent_005 | -16.2 | -6.16 | 3.8 | -3.85 | 0.80 |

### Which test raised each one

| What raised it | Cases | Reported |
|---|---|---|
| The headline was called significant (bar 2), and the drill then named a part | 4 (`s301`, `s302`, `s320`, `guide_s25`) | headline z 2.2 to 3.7 |
| The whole was flat; one team or agent was flagged as moving on its own (the `dispersion` flag) and reported as a finding | 5 (`s318`, `guide_s21`, `guide_s22`, `guide_s24`, `guide_s26`) | part z 4.0 to 5.4, against a bar near 4 |
| The whole was flat; parts were flagged as moving against each other (the `offsetting` flag) and one reported | 4 (`s312`, `queue_s305`, `queue_s314`, `queue_s318`) | parts moving 1.8 to 2.7 points in total around a net of under 1 |

No false alarm came from a time bucket.

### The guide's four suspects

- **Parts judged on counting noise only: confirmed, in a slightly different form.** A part's z does get the extra spread
  (`core/runner/src/drill.ts`, `decomposeChildren`), but it is the spread estimated for the whole KPI, applied to every part.
  Twelve teams wobbling on their own make the whole wobble far less than any one of them (here the whole's own spread is 0.1
  to 0.9 points, a team's 1 to 3.5), so the correction barely moves a team's z. Judged by its own five weeks, 8 of the 13
  reported parts are under 3.
- **Thin history: confirmed.** Week 6 has five earlier weeks, exactly the fewest the spread estimate accepts
  (`MIN_DISPERSION_PERIODS`), and the comparison uses four of them. The whole's wobble in this data should be about 0.6 to
  0.7 points; from five weeks it is estimated at 0.14 to 0.4 in the four headline cases, at or below counting noise, so a
  move of 1 to 1.4 points reads as z 2.2 to 3.7. The same thinness hurts a part's own estimate: three parts (`s301`, `s312`,
  `guide_s24`) happen to have had five steady weeks and read z 6 to 7 on their own spread. So a part's own spread alone is
  not enough at this length; it has to be steadied with what the other parts at the same level show, as the guide proposes.
- **Many comparisons, one bar: not the cause here.** The bars already tighten with the number of parts at a level. The z
  values are too large, not the bars too low. The parked run-wide family (6c) measured the same: no effect.
- **The `dispersion` flag: 5 of the 13, and each time the flagged part is also the finding.** Turning the flag into a note
  quiets nothing unless the finding goes with it; the finding goes once the part is judged on a fair spread.

### Why 5 of 6, 5 of 20 and 6 of 100

Partly explained. The suite judges week 6, the thinnest history the analysis accepts, where both causes above are at their
worst; the rate table judges the last 25 of 30 weeks, most with twelve earlier weeks for the estimate. That accounts for the
table being lowest. It does not account for 5 of 6 against 5 of 20 at the same week: the six seeds may simply be unlucky.

### Not shown in this diagnosis

- **Later weeks of the same datasets were not judged.** A run of weeks 7, 8 and 10 on the 26 team datasets, to show the rate
  falling as history grows, was stopped by the machine for low memory and not restarted. (Week 9 cannot be used: it is a
  special week the analysis declines to compare.) So "thin history" rests on the estimates above, not on that direct test.
- **"Own spread" here is a plain standard deviation of five weekly rates,** computed outside the analysis as a yardstick.
  It is not the estimator Phase 2 will use and was not tried as a fix.
- **Only the false alarms were taken apart,** not the quiet weeks that stayed quiet, so nothing here says how many true
  findings a fair spread would cost. The noise-plus-fault cases are the check for that.
- **The delivery week (W30) and the missed outages were not taken apart.**

## Regression at the close

| Check | Result |
|---|---|
| `npm test` | all pass; D7 and D8 listed as skipped with their reason |
| `npm run check:purity`, `npm run check:ladder` | pass |
| `npm run eval` | 25 of 25 |
| Routing eval | 38 of 38, and 5 known gaps still open |
| Intent eval | 16 of 16 |
| Integration tests | 8 of 8 |
| `npm run eval:deliveries` | 8 of 8, and 2 known gaps still open |
| `npm run eval:noise` | run end to end on 15 November: 100 of 101 ordinary cases, 25 gaps open, **one new failure** (see the correction below); with that case marked, 100 ordinary cases and 26 gaps |

### Correction, 15 November: one case changed between two runs of the same seed

The first version of this page said 4 of 20 quiet weeks by team (7 of 40 in all) and 25 gaps. The full re-run with the
markers in place found `quiet_team_service_level_s302` raising a finding. It had passed in the first run, and it fails every
time now (three runs). The generator is not the cause: the same seed writes identical files (checked three times).

The likely cause is the build, not the analysis: the first run, from which the markers were set, was made 39 minutes after
switching back from the parked branch (`wip/false-alarm-6c-6d`), and the compiled code was rebuilt only an hour and a half
after that run. So the first run probably ran the parked branch's code. This is inferred from file times, not proven. If it
is right, the parked changes turned exactly one of these 126 cases quiet and changed no other verdict, which agrees with
their having almost no effect elsewhere.

The numbers on this page are now from the re-run on the committed code: 5 of 20 by team, 3 of 20 by queue, 8 of 40 in all;
every other count was the same in both runs. The rate table, the delivery results and the routing results were made after
the rebuild and are not affected.

## Not shown

- **The first run's build is not known for certain** (see the correction above). The counts published now come from one full
  run on the committed code, plus three repeats of the one case that changed.
- **No defect is fixed.** Every number here is the before.
- **The spread between 5 of 6, 5 of 20 and 6 of 100 is not explained.**
- **The rate table is 4 seeds for each level,** not the 6 the nightly run uses, and 12 planted faults for each cell; the
  intervals are wide and the detection columns cannot separate 8 of 12 from 10 of 12.
- **The gap markers were set from one run on one machine** (Windows, SQLite through Toolbox). A case near the edge may come
  out differently on another platform; the nightly run on Linux has not run yet and may report a closed gap or a new miss.
- **The nightly workflow has not run on GitHub.** It was written and read, not executed.
- **The delivery pack is one seed.** One quiet week in seven raising something is a single observation, not a rate.
- **The delivery inject run used the plain `--no-fault` data;** the independent run's exact data and settings are not known,
  so 1 of 4 here and 1 of 3 there are the same direction, not the same measurement.
- **The wobble is by team in the rate table.** By queue is in the eval cases only.
- **Handle time has no wobble of its own in the generator,** so "0 of 40" shows that noise in one KPI raises nothing in
  another, not that handle time is safe when it wobbles.
- **D5 and D9 have no test yet.**
- **No live assistant and no BigQuery** were used in this phase.

## Phase 2, step 2.1: each part judged by its own spread, steadied by its siblings

**The change.** A part's z used to allow for the extra week-to-week spread of the whole KPI. It now allows for the part's own
(`core/runner/src/levelspread.ts`). For each level the drill looks at, the same query is asked for up to 12 earlier periods
with the same calendar flags (two periods a call). Each part's excess over counting noise is worked out the way the whole's
is. The level's typical excess is the average over its parts. A part is then judged by its own excess pulled toward the
level's, with the level counting for 12 periods of the part's own history. Counting noise is the floor. With fewer than 3
earlier periods nothing changes. No threshold or bar was changed, and the numbers 12 and 12 were set before any run and not
adjusted after.

**Before and after, noise suite** (126 cases, wobble of 2 points by team or by queue, week 6, 15 November):

| Group | Before | After |
|---|---|---|
| Quiet weeks, service level, seeds 301 to 320, by team: raise something | 5 of 20 | 2 of 20 |
| Quiet weeks, service level, seeds 301 to 320, by queue | 3 of 20 | 0 of 20 |
| Quiet weeks, service level, the guide's seeds 21 to 26 | 5 of 6 | 2 of 6 |
| Quiet weeks, handle time | 0 of 40 | 0 of 40 |
| A team understaffed, on top of the wobble: found | 10 of 10 | 10 of 10 |
| A team's calls 1.5 times as long: found | 10 of 10 | 10 of 10 |
| A two-hour outage, headline normal: found | 3 of 10 | 3 of 10 |
| One agent's bad week (no wobble): found | 4 of 10 | 4 of 10 |
| Ordinary cases passing | 100 of 100 | 100 of 100 |

On the 40 new seeds the false-alarm rate is 2 of 40 (5%; 95% interval 1.4% to 16.5%); over all 46 quiet service-level weeks,
4 of 46 (8.7%; 3.4% to 20.3%). Nine gap markers came off in this commit; 17 remain.

**Main eval:** 25 of 25 before and after. **Runner unit tests:** 192 pass, six of them new (the estimator recovers a known
wobble, gives about zero on counting noise alone, pulls a part with five steady weeks toward its siblings, lets a part with a
long history keep its own, never goes below counting noise, and handles totals).

**What is still raised, and by what:**

| Case | Raised by | Next |
|---|---|---|
| `team_s301`, `team_s320` | the headline is called significant (z 3.7 and 3.2 against a bar of 2, with the whole's spread estimated from five weeks), then a centre is named | step 2.2, the headline on thin history |
| `team_guide_s24`, `team_guide_s26` | a single agent under a flat whole (z -5.6 and -4.4). An agent's weeks carry its team's wobble plus its own small numbers; a team's ordinary bad week makes one of its agents look far out | not yet decided: a material-effect rule or judging an agent against its team |

**What it costs.** Each level asks about earlier periods, so a question takes more queries: the 25 questions of the main
eval went from 528 queries to 922 (the largest from 35 to 59), and from 342 seconds to 440 on a local database.

### Not shown

- **The rate table by noise level was not re-run with this change.** The run was stopped by the machine for low memory after
  two seeds of the first level and was not started again. So there is no after for the 1%, 5%, 6%, 12% table, and none for
  detection of planted faults at 4 and 6 standard errors beyond the eval cases above.
- **The integration tests, routing, intents and the delivery pack were not re-run for this commit.**
- **Query cost on BigQuery is not measured.** More queries mean more bytes billed; a single query for a level's history is
  the likely fix and is not built.
- **Only week 6 is measured,** the thinnest history. Whether the shrink gives too much or too little weight to a part's own
  history when there are 12 or more periods is not tested on data, only in a unit test.
- **Totals (a volume KPI) are covered by one unit test and the main eval,** not by a noise suite of their own.
- **The two missed groups (outages, small units) did not move,** and the delivery pack's quiet week and planted faults were
  not re-measured.
- **Real complaints data was not run.**

## Phase 2, step 2.2: the headline's bar when the spread was learned from few periods

**The change.** The headline is called significant when its z reaches a bar, 2 by default. That bar is a normal quantile and
treats the data's own spread as known. When the spread was estimated from a handful of earlier periods it is not known, and
the right reference is Student's t. The bar now keeps the significance level that 2 stands for and takes the t quantile at
that level for the history available (`thinHistoryBar`, `core/runner/src/masking.ts`): 2.87 with five earlier periods, 2.43
with eight, 2.26 with twelve, and 2 when nothing was estimated. A bar that a pack or a run sets by name is used as given.
The default significance level is unchanged.

**The alternative, measured and not adopted.** The opt-in bar from the earlier step 6b (a hundredth as the headline's level,
then the t quantile: 4.6 with five periods, 3.1 with twelve) was tried as the default first, as agreed with the owner, on top
of step 2.1. It again lost one of the 25 planted cases (`share_shift_to_one_agent`: no finding), so it stays opt-in.

**Before and after** (before is step 2.1; 15 November; the noise suite was run in five parts, all 126 cases):

| Group | Step 2.1 | Step 2.2 |
|---|---|---|
| Quiet weeks, service level, seeds 301 to 320, by team: raise something | 2 of 20 | 1 of 20 |
| Quiet weeks, service level, by queue | 0 of 20 | 0 of 20 |
| Quiet weeks, service level, the guide's seeds 21 to 26 | 2 of 6 | 2 of 6 |
| Quiet weeks, handle time | 0 of 40 | 0 of 40 |
| A team understaffed, on top of the wobble: found | 10 of 10 | 10 of 10 |
| A team's calls 1.5 times as long: found | 10 of 10 | 10 of 10 |
| A two-hour outage, headline normal: found | 3 of 10 | 3 of 10 |
| One agent's bad week: found | 4 of 10 | 4 of 10 |
| Main eval | 25 of 25 | 25 of 25 |

On the 40 new seeds the false-alarm rate is now 1 of 40 (2.5%; 95% interval 0.4% to 12.9%), from 8 of 40 at the start of
the phase. Over all 46 quiet service-level weeks it is 3 of 46 (6.5%; 2.2% to 17.5%), from 13 of 46. One more gap marker
came off (`quiet_team_service_level_s301`); 16 remain. Unit tests: all pass (193 in the runner, one new for the bar).

**What is still raised:** `team_s320` (the headline reads z 3.2, over the new bar of 2.87; the whole's spread from five
weeks is still estimated below counting noise) and the two single agents of step 2.1.

**One unit test was changed.** `range.test.ts` showed that, with no weekly cycle declared, an ordinary weekend day looks
like a collapse, by asserting that the run called it significant. It reads z -2.23, and the bar for its twelve earlier
windows is now 2.26, so it is no longer called significant. The test now asserts what it was there to show: the naive
comparison reads a 30-point drop and the like-for-like comparison reads none.

### Not shown

- **The rate table by noise level has still not been re-run** since step 2.1 (stopped for low memory, not restarted), so
  detection of planted faults at 4 and 6 standard errors over 30 weeks is not known for either step. A higher headline bar
  can only lower it; the eval and noise cases above lost nothing, but they are large faults.
- **Integration tests, routing, intents and the delivery pack were not re-run.**
- **The bar jumps at five periods:** with four earlier periods nothing is estimated and the bar stays 2, which is the least
  cautious setting at the point where least is known. Not changed here.
- **One false alarm from the headline remains,** and one sample of 40 cannot tell 2.5% from the 5% target either way.
- **Real complaints data was not run.**

## Phase 2, the rate table after steps 2.1 and 2.2

`node scripts/noise-rates.mjs --levels 0,0.01,0.02,0.03 --seeds 4 --sizes 4,6`, the same command, seeds and weeks as the
Phase 0 table (15 November, committed code at step 2.2). Data: `docs/evidence/data/noise-rates-after-2.2.json`; the before
is `docs/evidence/data/noise-rates.json`.

| Wobble (points) | Quiet weeks judged | Raised something, before | After | False-alarm rate after | 95% interval | Faults found at 4 standard errors, before | After | At 6 standard errors, before | After |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 100 | 1 | 1 | 1.0% | 0.2% to 5.4% | 10 of 12 | 9 of 12 | 12 of 12 | 12 of 12 |
| 1 | 100 | 5 | 2 | 2.0% | 0.6% to 7.0% | 8 of 12 | 8 of 12 | 10 of 12 | 10 of 12 |
| 2 | 100 | 6 | 6 | 6.0% | 2.8% to 12.5% | 8 of 12 | 8 of 12 | 10 of 12 | 10 of 12 |
| 3 | 100 | 12 | 5 | 5.0% | 2.2% to 11.2% | 5 of 12 | 7 of 12 | 10 of 12 | 10 of 12 |
| All four | 400 | 24 | 14 | 3.5% | 2.1% to 5.8% | 31 of 48 | 32 of 48 | 42 of 48 | 42 of 48 |

- False alarms over the four levels fell from 24 of 400 to 14 of 400. Detection did not fall: 32 of 48 against 31 of 48 at
  4 standard errors, 42 of 48 both times at 6.
- **The 2-point level did not move: 6 of 100 before and after,** while the levels on either side fell. This is the level
  the guide's target is stated at, and it is still just above one in twenty. The week-6 eval cases at the same wobble fell
  from 8 of 40 to 1 of 40, so the two measures now disagree in the other direction. What raises these six weeks has not been
  looked at; they are later weeks with longer histories, where step 2.2 changes the bar little.
- One planted fault at 4 standard errors that was found on clean data is now missed (10 to 9 of 12); two more are found at
  the 3-point level. With 12 a cell these are within chance.

### Not shown

- **Why the 2-point level is unchanged.** Not diagnosed.
- **Four seeds a level,** as before; the nightly run uses six and has not run.
- **Wobble by team only.**
- **Integration tests, routing, intents and the delivery pack are still not re-run** for steps 2.1 and 2.2.

## Phase 2, step 2.3: tried and not adopted, and what the remaining alarms are

### What raises the rate table's remaining weeks

Every one of the 14 flagged weeks in the table above was raised by the headline being called significant (z 2.1 to 3.9),
all but one with no flag from a part; the findings listed with them come from the step that names contributors to a change
already called real. A headline bar of 2 allows about 4.6% of ordinary weeks by design (a little less after step 2.2).
14 of 400 is 3.5%, and 6 of 100 at the 2-point level is inside what that rate gives by chance. So the table now sits at the
headline test's own rate. One week (seed 1003, week 11) is raised at every noise level including none, so it belongs to
that seed's base data and not to the wobble.

Going lower means a stricter default level for the headline. That is the owner's decision, and the stricter bar measured in
step 2.2 lost a planted case.

### A swept part must stand apart from its own parent: tried, not adopted

The two quiet weeks still raised by a single agent (`team_guide_s24`, `team_guide_s26`) looked like a team's ordinary bad
week carrying one of its agents far out. The change tried: a part found by sweeping a deep level under a flat whole is a
finding only if it also moved differently from the rest of its own parent (z of 3 or more on counting noise).

| Case | The agent's move | The rest of its team | z of the difference | Planted? |
|---|---|---|---|---|
| `team_guide_s24`, agent_041 | -18.7 points | -4.3 | -3.47 | no |
| `team_guide_s26`, agent_005 | -16.2 points | -3.3 | -3.45 | no |
| `small_unit_agent_s201`, agent_023 | -15.1 points | -1.1 | -3.41 | yes |
| `small_unit_agent_s205`, agent_023 | -17.7 points | +0.2 | -4.46 | yes |

The rule kept all four planted agents that are found today and removed neither false alarm. The two false alarms stand as
far from their teams as a planted one does. With 60 agents and 46 quiet weeks, about 0.8 agents that far out are expected
from counting noise alone; two were seen. They are the ordinary tail of many small units, not something a rule about
parents can separate from a real 15-point drop in one agent. A bar high enough to drop them would drop a planted case too,
and choosing that bar from these four rows would be tuning on the cases reported. The code was removed (two extra queries
for no measured gain). This is the guide's D4: a unit this small is below what one week can show, and the answer should say
so; that belongs to Phase 3.

### Where the false alarms stand

| Measure | Start of Phase 2 | Now |
|---|---|---|
| Quiet weeks, 2-point wobble, week 6, 40 new seeds | 8 of 40 | 1 of 40 (2.5%; 0.4% to 12.9%) |
| The guide's six seeds | 5 of 6 | 2 of 6 (both single agents) |
| Rate table, 2-point wobble, 100 later weeks | 6 of 100 | 6 of 100 (all from the headline) |
| Rate table, all four levels | 24 of 400 | 14 of 400 (3.5%; 2.1% to 5.8%) |
| Clean data (rate table, no wobble) | 1 of 100 | 1 of 100 |

### The outages that are "missed" are mostly found in part

Of the seven two-hour outages marked as missed on noisy data, six name the right day and a stretch inside the outage
(12:00 to 12:30, 12:30 to 13:30, 12:00 to 13:30 and so on); the case expects the exact stretch the clean-data case finds
and so fails. One (`block_outage_with_noisy_queue_s401`) raises nothing. The cases were not loosened. Whether a finding that
overlaps the planted stretch should count is a question about the case's wording for the owner, not something to change
quietly.

### Not shown

- **The stand-apart rule was measured on 12 cases only** (the two false alarms and the ten agent cases), not on the whole
  suite; it was dropped on that evidence.
- **The expected 0.8 is a back-of-envelope figure** from a normal tail, not a simulation.
- **Steps not started:** a material-effect rule, the false discovery rate across a run, the fault planter in the detector's
  units, calibration on short history, and anything on real complaints data.

## Phase 2: outages on noisy data counted by the planted stretch, and the regression after steps 2.1 and 2.2

**A change to what ten cases assert, agreed with the owner (15 November).** The outage is planted on Wednesday 11 February
from 12:00 to 14:00, the half hours 12:00 to 13:30. The ten noise cases expected the exact stretch the clean-data case
finds (12:00 to 13:00). With the wobble the edges move, and a run that named 12:30 to 13:30 failed. The cases now use a new
expectation, `findings_within`: a finding in that dimension must lie inside the planted stretch. Naming part of the stretch
counts; a finding that starts before it or ends after it, on another day or in another dimension, does not. The analysis
did not change. The clean-data case in the shipped eval still expects its exact stretch.

| Outage on noisy data, 10 cases | Exact stretch (old rule) | Inside the planted stretch (new rule) |
|---|---|---|
| Found | 3 | 9 |
| Not found | 7 | 1 (`block_outage_with_noisy_queue_s401`: nothing raised) |

Faults on top of the wobble found, all three kinds: 29 of 30 (97%), against the guide's target of at least 90%. Under the
old rule it is 23 of 30. Six gap markers came off; ten remain in the noise suite (one quiet week from the headline, two
quiet weeks from single agents, one outage, six small-unit weeks).

**Regression on the code of steps 2.1 and 2.2** (the checks those commits had not re-run):

| Check | Result |
|---|---|
| Unit tests, all packages | pass (one new for `findings_within`) |
| Main eval | 25 of 25 |
| Routing | 38 of 38, 5 known gaps open |
| Intents | 16 of 16 |
| Integration | 8 of 8 |
| Delivery pack | 8 of 8, the same 2 gaps open (the quiet week W30 still raises a finding; the combination is still two findings) |
| Purity, ladder names | pass |

### Not shown

- **The whole noise suite was not re-run after this change;** only the ten outage cases were, since nothing else in it
  changed.
- **"Inside the planted stretch" says nothing about how much of the outage was named.** A single half hour of the four
  counts the same as all four.
- **The delivery pack did not improve:** its quiet week and its planted-fault check (`inject_faults`) are untouched by
  steps 2.1 and 2.2; the planter is step 3.
