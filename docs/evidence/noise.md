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
