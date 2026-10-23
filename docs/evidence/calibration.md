# Calibration: evidence

Phase 2 of `PROGRESS.md`. Each section is one step; each ends with what was not shown.

## Step 0: what counts as an alarm, measured (spike, not product)

`scripts/calibration-spike.mjs` replays `metric_change` over every complete past period of a pack's own history (a four-period baseline first), with no faults planted, and records what each run said. Rows are in `runs/calibration/` (not committed). One run each.

**Contact-centre (synthetic, SQLite), seeds 1 to 4, no faults, 72 replays over 3 KPIs.** 12 stopped, all of them week 9 with `no_comparable_baseline` (the pack's holiday week): the analysis declining to judge, which is correct. Of the 60 judged: 2 raised something, both service level in week 8 (one a significant headline with no finding, one a finding with a time-block flag). **2 of 60 = 3.3%.** About 7 seconds a replay; no bytes (SQLite).

**Complaints (real, BigQuery), newest 16 complete weeks of 2 KPIs, 32 replays, about 14.6 GB and 51 s a replay (about 470 GB, roughly $3 at list price).** 6 stopped, all `data_quality` in holiday weeks (also correct); 2 errors (the series tool returned no rows for two weeks near the end of the data; to be handled as "could not judge"). Of the 24 judged:
- **complaint volume: 11 of 11 judged weeks have a significant headline** (z from about 4 to 23 in size, either sign), 10 of them with findings.
- **timely response rate: 6 of 13 raised something**: 3 significant headlines and 3 weeks with findings or time-block flags under a non-significant headline (the parked "quiet weeks report findings" problem).

| Candidate meaning of "alarm" | contact-centre (judged 60) | complaints (judged 24) |
|---|---|---|
| a. significant headline, a finding, or a masking flag other than thin cells | 2 (3.3%) | 17 (71%) |
| b. significant headline only | 1 (1.7%) | 14 (58%) |
| c. significant headline and a finding | 0 | 12 (50%) |

**What it says.** The headline test is badly out of line on the real data: weekly complaint volume moves by much more than counting noise alone would allow, and the headline test (`zSum` / `zScore` in `core/runner/src/tasks.ts`) treats the count as if only row-level noise existed. The contributions already use a dispersion-adjusted test (`adjustedZ`, `core/runner/src/dispersion.ts`); the headline and the time buckets do not, which is the item parked since sprint 3. On synthetic data built from Poisson-like noise the problem does not show (3.3%). This is exactly what calibration is for, and it means that **today the complaints KPIs would not pass calibration**.

**Decision.** Alarm = a judged period (the run completed) in which the analysis claims something: a significant headline, a finding, or a masking flag other than thin cells (definition a). A period it declines to judge is reported separately ("could not judge N periods") and is not in the denominator; an error counts as could-not-judge. Every alarm counts as false until the person labels it real.

**Not shown.** Whether a dispersion-adjusted headline brings the complaints rate under 1 in 20 (not tried); how many of the complaints alarms are real events (no labels yet; volume did move a lot in these weeks); a longer history than 16 weeks; other KPIs of the complaints pack (monetary relief rate); any rate for an alerts-style pack.
