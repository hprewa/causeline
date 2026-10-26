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

## Step 0b: the analysis allows for the data's own movement, and holds claims inside a flat whole to a higher standard

**Why.** Step 0 showed the headline test calling 11 of 11 judged complaint-volume weeks significant. A change here is a code change to the analysis, so every existing result was re-checked.

**What changed (`core/runner`).**
1. The headline z allows for the data's own period-to-period movement, estimated from earlier periods that share the period's calendar flags (`estimateDispersion`, `adjustedZ`, and `inflateZ` for the seasonal form). Unchanged when there are fewer than 5 such periods.
2. The whole period's verdict inside the time drill is the headline's, so one run does not answer "did it change?" two ways.
3. Inside a flat whole, a node or slot must clear a stricter bar (the family significance level is tightened tenfold, `FLAT_WHOLE_ALPHA`), a slot is judged against its own level's spread (`bucketDispersion`, used only here), and a finding is checked against the node's own last eight periods (`dropUsualFindings`, using the existing contribution verdicts); one that moves this much in ordinary periods is left out with a note, and its flag with it. A real change keeps the drill's own verdicts.
4. A slot found inside a flat whole is reported but the rest of the run still looks at the whole period; narrowing to it hid the company-level change in the Wells Fargo case.

**Tried and not kept.** (a) A materiality rule (a node must carry at least the whole's standard error): it removed the real Wells Fargo incident, whose own count rose by 190 on about 214 a week (z = 7.7) while the week's total is too noisy to notice; a stricter bar replaced it. (b) A day- and interval-level spread applied everywhere: it made one half-hour of a real surge fall to z = 3.5 against a bar of 3.53 and broke the run into pieces, so it applies only inside a flat whole.

**Measured (one run each).**
- Existing checks after the change: unit tests pass (runner 176, all packages green), contact-centre eval **25/25**, routing **38/38**, intents **16/16**, integration **8/8**, complaints eval on real BigQuery **7/7** (including the real Wells Fargo incident), purity and ladder checks pass.
- Contact-centre replay, no faults, 4 seeds: 72 replays, 12 declined (holiday week), 60 judged, **2 raised something (3.3%)**, the same two week-8 cases as before.
- Complaints, newest 16 complete weeks, 2 KPIs (BigQuery, about 17 GB a replay): judged-week alarm rate **71% before, 58% after** (volume 11 of 11 before, 11 of 13 after; timely rate 6 of 13 before, 4 of 13 after). The headline alone moved from 14 of 24 significant to 2 of 26. Most remaining alarms are findings under a flat headline. **This stretch is not quiet:** it holds a persistent surge in Wells Fargo checking-account complaints (z up to 27, still off in the following weeks), so those alarms may be real; they cannot be called false until the person labels them, which is what calibration's labelling step is for. The published rate will be computed on a window chosen with that in mind and say so.

**Not shown.** A false-alarm rate on complaints that is not mixed up with real events; whether the remaining flat-whole findings are real; behaviour on packs without declared cycles beyond the unit tests; the cost of the extra history check on large packs (up to six day-level queries a run, only when the headline is flat); the parked sprint-3 item "benjamini-hochberg across all nodes".

## Step 1: the calibration core and its tools

**What it is.** `core/builder/src/calibrate.ts` replays a reconciled KPI's deep dive over its own past periods (the newest 26 complete ones with a baseline before them, leaving out the incidents the person recorded) and counts the periods in which the analysis claims something (a significant headline, a finding, or a hidden-pattern flag other than thin cells). A period it declines to judge is reported and counted neither way. Every claim counts as a false alarm until the person says something real happened then. The rate is compared with what the person allows (one in twenty unless they change it; a change is kept); with fewer than 8 judged periods the rung cannot be earned however quiet. Each period's outcome is written to `calibration-<kpi>.json` as soon as it is known, so a stopped replay resumes, a label needs no new replay, and a KPI whose meaning changed (a hash of its definition, the data it reads and the alarm rule) starts again. A pass sets the KPI's `calibration` (the rung follows through `levelOf`, the change goes to the status log, the KPI's expert follows its KPI). A call works for about 40 seconds and reports progress, because clients time a tool call out after about a minute. On cloud data it first returns what the replay would read (measured from the first period once there is one) and waits for a go-ahead above 1 GB. Three tools: `calibrate`, `label_period`, `calibration_status`; the sign-off page and project page show the rate; the build guide has a step 6b for it.

**Shown.**
- 12 unit tests on the core (a quiet KPI is calibrated with the rung and reason logged; one that raises too much stays reconciled and lists the weeks; a label takes a week out of the count and the rung follows without a new replay; a declined week is counted neither way; too few weeks cannot pass; a KPI that is not reconciled is refused; a stopped replay resumes without repeating weeks and a changed KPI starts again; the allowed rate change is kept; the cloud estimate and the go-ahead; what counts as a claim; the rate, its upper bound and its words) and 4 on the tools' wording.
- A real run through the MCP server over stdio on the contact-centre data (30 weeks, seed 1, no faults, a KPI recorded as reconciled; `scripts/calibrate-proof.mjs`): 26 periods replayed in 98 s over 3 calls on a real Toolbox; 25 judged, 1 declined (the holiday week, "no comparable baseline"), **2 raised something (about 1 in 13)**, which is over the 1 in 20 allowed, so the KPI stayed reconciled and the two weeks were listed. **A caveat on the rest of that run:** the proof then labelled one of the two weeks "real" only to exercise the labelling path (nothing real happened in that made-up data), after which the rate was 1 of 24 and the KPI became calibrated. That shows the mechanics, not that the KPI is calibrated. The published rate for this pack is a step 5 job.
- Existing checks: unit tests pass in every package (builder 73, mcp-server 60 and 8 that need the integration switch), purity and ladder checks pass, integration 8/8 after rebuilding the plugin bundle.

**Not shown.** Calibration on BigQuery (the go-ahead path is unit-tested only; the real cost per period is the step 5 measurement); the hit rate beside the false-alarm rate (it arrives with step 2, because it needs the held-out incidents); a live assistant using the tools and asking about flagged weeks one at a time; whether 40 seconds is short enough for every client; long histories (the cap is 26 periods, so a stable pattern older than that is not seen).

## Step 2: incidents kept aside, and describing an incident in words

**What it is.**
- **Kept aside.** `add_incident` takes `held_out`. By default the first incident of a KPI may help while the analysis is set up and every later one is kept aside: it is looked at only when the expert is checked (`verify_expert`) and never used to adjust anything. The calibration never receives an incident's text or id, only the windows to leave out of the ordinary periods (a test checks that neither its report nor its file holds the wording of an incident kept aside).
- **What counts as proof.** An expert is `verified` only when the KPI is calibrated **and** an incident kept aside was found (or, from step 3, faults planted in the person's own data were found). Finding the one incident that helped set the analysis up is recorded but says so: it was available while the analysis was set up, so it is not independent proof. `verify_expert` still works on a reconciled KPI, so the incident check can come before the false-alarm check; the rung needs both.
- **What is kept.** The share of recorded incidents found (`hit_rate`), the ones kept aside that were found and the ones that were not, on the KPI. A miss now removes a verification it had (an expert that stops finding what it found is not verified), and for an incident kept aside the report says only that it was not found, not what the analysis said instead, so there is nothing to bend the analysis to fit.
- **Describing an incident in words.** `propose_incident` takes what the person pasted or said, with when and where as the assistant read it, and checks it against the data with no model call: the period must exist (resolved by the same code that reads a question's period), the dimension must be one the data can be broken down by, and the value must be a real one that had activity in that window (one call of the same slice tool the analysis uses; a different spelling of a real value is corrected). It returns the exact `add_incident` arguments for the person to confirm, or what could not be placed with the values that do exist. Nothing is recorded by it.

**Shown.**
- 5 new unit tests (the default for the first and later incidents and the override; a described incident placed and turned into the exact record, the first allowed to help and the next kept aside, a wrong-case value corrected; every kind of failure said in words with real values and nothing invented: unknown value, unknown dimension, no date, an unreadable date, a date outside the data, backwards dates, sloppy date format; dates becoming a date range; an incident kept aside absent from the calibration). The tool wording of the other tools is unchanged.
- The integration end-to-end flow now includes the new rule: with one incident its finding is recorded as not independent proof (`pass` false, `hit_rate` 1); after a second incident (kept aside by default) is found, verification passes with 1 of 1 kept aside and the KPI stays reconciled because calibration has not been run. Integration 8/8; unit tests pass in every package (builder 78, mcp-server 60); purity and ladder checks pass.

**Not shown.** A live assistant using `propose_incident` on a real pasted post-mortem (only the tool's own checks); BigQuery (the slice call is the same one the analysis makes, but it was only exercised through a stub in the unit tests and through the SQLite pack in the integration flow); the second incident in the integration flow is the same fault described again, so it shows the mechanics, not that two different incidents are found; the default (first incident helps, the rest are kept aside) is a policy, not a measurement.

## Step 3: planting known faults in a copy of the person's own data

**What it is.** `core/builder/src/inject.ts` and the `inject_faults` tool. It takes the newest ordinary period the false-alarm check found quiet (judged, nothing raised, not called real), writes the KPI's fact out as a table in a scratch copy of the whole project, and plants four kinds of fault in that table's rows, each in a fresh copy:
1. **a shift in one part** (a dimension's biggest part): rows that favour it are swapped for copies of rows that count against it, so its rate moves and the volume does not;
2. **an offsetting pair**: one part made worse and another made better, so the whole looks flat;
3. **volume moving between parts**: rows of every other part are replaced by copies of rows from the part with the worst rate, so no part's rate changes and only the weights do;
4. **a part's data missing**: all of one part's rows in the period are removed.
The analysis runs on each copy with the project's own query tools; a shift must name the planted part, an offsetting pair must name the worse part and raise a masking flag (an offsetting or a flat-whole-hiding-a-worse-part flag), a mix shift must name the part that gained volume, and a missing part must make the analysis decline for a reason about the data. The same period with nothing planted is run too: if it is not quiet, the results do not count. Planted sizes are chosen to be about six standard errors for the part they are planted in (and a fault is declined as "cannot be planted here" when the data cannot hold one that size, for example a mix shift between parts whose rates are close), and everything is reproduced from a seed. The result is kept on the KPI (`faults_passed` out of `faults_total`) and counts as independent proof only when every fault that could be planted is found, none was skipped silently, the unchanged period stayed quiet, and any recorded incidents were found too; with the KPI calibrated that makes it verified. It works about 40 seconds at a time and resumes. The person's own database and definition files are checked byte for byte to be unchanged. Files and local databases only; cloud data is refused with the reason.

**Shown.** 5 tests. On 12 weeks of ordinary data (four sites with steady rates of 95, 80, 60 and 40 percent, nothing planted; the false-alarm check run on it for real, with no model and no Toolbox): the unchanged period stayed quiet; **all four kinds were found** (a shift in north; north worse with south better; volume moved to the worst site; north missing, where the analysis declined); the person's database and definition were byte-identical afterwards; the same seed plants the same fault and a finished run is not repeated; it refuses without the false-alarm check and on cloud data and says so; a stopped run resumes; the rung follows the result (the KPI became verified here, because its false-alarm check passed). Tool wording tested. Unit tests pass in every package (builder 82, mcp-server 61), integration 8/8, contact-centre eval and purity pass.

**What the first attempts taught, kept because it changes how to read the result.** (a) A fixed-size shift was too small for a part already at 95%: the analysis was right not to see it, so sizes are now adaptive. (b) Taking rows away changed the period's volume, and in the newest period the analysis then declined as "data still arriving"; shifts now swap rows so volume stays the same, and only the missing-data fault changes volume. (c) A mix fault made by relabelling rows changes nothing in the rate; it is now built from new volume of the destination's kind. (d) A missing part in the newest period is met by "data still arriving" as often as "data quality": both are accepted as declining for a reason about the data.

**Not shown.** The faults are sized by construction to be clear (about six standard errors): this shows the analysis finds clear faults, not subtle ones, and a detection curve against size is not measured; one dataset of ordinary synthetic data built with steady rates (the real data of the shipped packs is step 5); hierarchies (only a flat dimension is used; a KPI whose only parts are in a hierarchy is refused); a ratio over non-binary values (the swap uses the rows' own values but was only exercised on 0 and 1); a live assistant using the tool; cloud data.

## Step 4: how sure an answer is

**What it is.** `confidenceOf` (`core/runner/src/confidence.ts`), a pure function, and a `confidence` field on every answer from `run_intent`: a label (high, moderate, low, or none) and `because`, the reasons in plain words. Nothing in it comes from a model's feeling about the answer.
- **Evidence strength**, from fields the run already carries: the change itself is larger than the data's ordinary movement (+1; a part standing out inside a whole that did not change gets no point and is said to rest on the part); the top finding's node is new or unusual against its own recent history (+1; usual, -1; not checked, 0, said); the parts named account for at least half of the change (+1) or under a quarter (-1; the share is quoted from the result); thin data at the finding's level was set aside (-1). Two or more points is high, one is moderate, otherwise low. An answer with no finding says only that nothing stands out, not that nothing happened.
- **The expert's rung sets a ceiling**: draft low, reconciled and calibrated moderate, verified high. The label is the weaker of the two, and when the rung holds it back the answer says so and what would lift it (the existing "what earns the next rung" sentence), including that the numbers were not confirmed against the person's reports.
- A run that declined, and an exploratory answer, are labelled none with the reason; none is not a verdict.
- The investigate guide (rule 5b) tells the assistant to say the label with one or two reasons next to the rung, never to raise it and never to replace it with its own sense.

**Shown.** 7 unit tests on a table of cases: strong evidence from a verified expert is high with the reasons in words; the same evidence is held to low for a draft (with the unconfirmed-numbers sentence and what would lift it), moderate for reconciled and calibrated; no rung gives more than its ceiling for any evidence; a flat whole is weaker than a changed one; an expected-usual node and thin data lower the evidence; an answer that finds nothing says only that; a declined or exploratory answer is none. In the integration run over a real Toolbox, a real answer carries the label and at least two reasons, and the note telling the assistant to say it. Unit tests pass in every package (runner 183), contact-centre 25/25, routing 38/38, intents 16/16, integration 8/8 (results that do not use the label are unchanged, because it is added after the run).

**Not shown.** That people read the label as intended (no one outside this work has seen it); that the thresholds (two points for high) match how right the answers actually are: the label is a rule, and it has not been compared with how often high answers turn out right, which is what the held-out and planted-fault checks of the earlier steps measure for the expert as a whole; a live assistant saying it in its own words; the explorer's answers (labelled none); the sign-off and project pages (they show the rung and the false-alarm rate, not the per-answer label).

## Step 5: the proof on two packs, and the rates

Numbers measured in this step; the scripts that made them and their raw outputs are named under each table (`docs/evidence/data/`). Every rate has its count and an interval, and where a number could be read two ways both are given.

### Contact-centre (synthetic, SQLite): the whole ladder, then the rates

**The full ladder, once, through the real server** (`scripts/ladder-proof.mjs`, seed 1, 30 weeks, two real incidents planted: a team short-staffed in week 13 and another in week 22). A script plays the model and the person; the person knows what really happened, so it answers "was something real going on?" truthfully and gives numbers worked out from the raw files, never from the system under test. In the order the build guide gives:
1. Description saved; three numbers from the files confirmed (a week, one centre, one day, from different periods and kinds): **reconciled**.
2. False-alarm replay of 26 periods: 25 judged, 1 declined (the holiday week), **2 raised something, and they were exactly the two weeks with planted incidents**; both were answered "real"; after that, 0 of 23 ordinary weeks raised something: **calibrated**.
3. The two incidents recorded through `propose_incident` and `add_incident`: the first can help set the analysis up, the second is kept aside by default.
4. Faults planted in a copy of a quiet week: **3 of 3 plantable kinds found** (a shift, an offsetting pair, a missing part) with the unchanged week quiet; the fourth (volume moving between queues) could not be planted because the queues' rates are too close.
5. `verify_expert`: both incidents found (hit rate 1 of 1, 1 of 1 kept aside): **verified**.
Raw: `data/ladder-contact-centre-seed1.json`. One seed, one run: it shows the path works end to end, not how often it does.

**False-alarm rate with nothing planted** (`scripts/rates.mjs`, 8 seeds of 30 weeks, the analysis' own tools, no model):

| | weeks judged | raised something | rate | 95% interval | declined to judge |
|---|---|---|---|---|---|
| all 8 seeds | 200 | 7 | **3.5%** | 1.7% to 7.0% | 8 (one holiday week per seed) |

Per seed 0 to 3 of 25 (seed 1006 had 3, 12%). This is within the one in twenty allowed, with an upper end of 7%.

**Planted faults found, by kind and size** (the same script; sizes are in standard errors of the part the fault is planted in; found of planted, with a 95% interval; the unchanged week raised nothing in all 32 runs):

| kind | 2 | 3 | 4 | 6 |
|---|---|---|---|---|
| a shift in one part | 0 of 8 (0% to 32%) | 2 of 8 (7% to 59%) | 7 of 8 (53% to 98%) | 8 of 8 (68% to 100%) |
| one part worse, another better | 0 of 8 (0% to 32%) | 3 of 8 (14% to 69%) | 7 of 8 (53% to 98%) | 8 of 8 (68% to 100%) |
| a part's data missing (met by declining) | 8 of 8 | 8 of 8 | 8 of 8 | 8 of 8 |
| volume moving between parts | not plantable | not plantable | not plantable | not plantable |

Read: on this data the analysis finds a shift of about four standard errors or more nearly always, finds a three-standard-error shift about a third of the time, and does not see two. Missing data is always declined. The mix kind could not be planted in any of the 32 cases (the pack's queues have rates too close for moving volume between them to change the whole by more than chance), so **it is not measured here**. The faults come from seeds the analysis was never tuned on; the 25 hand-written cases are not used and not counted.

### Complaints (real, BigQuery): the same check on the CFPB's public data

**Setup** (`scripts/complaints-signoff.mjs` then `scripts/complaints-calibrate.mjs`, project `yukti-dev`): the pack signed off against the CFPB's live published counts; the three real incidents the pack knows recorded (Wells Fargo's sales practices, September 2016, and Equifax's breach, September 2017, for complaint volume; Equifax for the timely response rate); then 20 periods **spread evenly through the whole history** (the newest weeks hold a persistent real surge) for each of two KPIs. The rule is stored with the outcomes: "20 of 590 complete periods, evenly spaced from 2011-12-26 to 2023-02-12; 2 more left out because they hold a recorded incident" (volume) and "20 of 591 complete periods, evenly spaced from 2011-12-26 to 2023-02-12; 1 more left out because they hold a recorded incident" (timely rate). Nothing was declined as not comparable in this sample. Cost: volume 329 GB ($2.05), timely rate 286 GB ($1.79) at list price, plus about 10 GB for the sign-off.

**Who said which weeks were real.** The person had not looked at the data, so the 13 flagged weeks were judged independently by a separate model (Opus) working only from the dates and a fixed rule written beforehand ("real" = a documented cause: a change in the database, a news, regulatory or company event, or a documented calendar effect such as a holiday week; "not real" = an ordinary week; "unsure" = cannot be established), using the CFPB's own public weekly counts for the 6 to 8 weeks either side and outside sources. Its answers are in `data/complaints-labels.json`.

| week | measure | verdict | reason (from its report) |
|---|---|---|---|
| 26–31 Dec 2011 | volume | **real** | Christmas week: 390 against about 490–600 before and 730–830 after; recurs every Christmas |
| 24–30 Nov 2014 | volume | **real** | Thanksgiving week: 2,158 against about 2,700–3,140 around it; recurs every year |
| 21–27 Apr 2014, 22–28 Aug 2016, 27 Mar–2 Apr 2017, 10–16 May 2021, 11–17 Jul 2022, 6–12 Feb 2023 | volume | not real | inside the range of the surrounding weeks |
| 13–19 Dec 2021 | volume | not real (medium) | the total was flat; Experian's daily count jumped from about 120 to 376–489 while the other two bureaus fell back; no documented cause was found |
| 26–31 Dec 2011, 18–24 Feb 2013, 18–24 Jan 2016, 6–12 Feb 2023 | timely rate | not real | inside the range of the surrounding weeks |

Caveats it raised, kept with the result: 11–17 Jul 2022 is the highest week in its window (low to medium confidence); 6–12 Feb 2023 is the last week of the copy the analysis reads, which ends on 12 Feb 2023, and the pack's own notes say its newest weeks were still filling in, so those two flags may be the copy's truncation and not an event (the reviewer saw today's live data, where the week is ordinary). A person who knew the data better might label differently; the labelling rule counts "unsure" and "not real" the same, so the rate would not change for those.

**False-alarm rate:**

| KPI | periods judged | raised something | rate, every flag counted (an upper bound) | after the reviewer's labels | recorded incidents found |
|---|---|---|---|---|---|
| complaint volume | 20 | 9 | 45% (26% to 66%) | **7 of 18, 39%** (95% interval 20% to 61%) | 2 of 2 |
| timely response rate | 20 | 4 | 20% (8% to 42%) | **4 of 20, 20%** (95% interval 8% to 42%) | 1 of 1 |

**Neither KPI is calibrated** on this data: the standard is one false alarm in twenty ordinary periods, and the rates are 39% and 20%. Both stay *reconciled*. The analysis was not changed to improve these numbers. Raw: `data/complaints-calibration.json`.

**What the flagged weeks look like.** Most are a week with a non-significant headline in which the analysis reports one or two findings in a small part (a state such as DE or RI, a sub-issue, a company, the web channel). That is the weakness the earlier steps reduced but did not remove: when many parts are compared (about 55 states, over a thousand companies), a few stand out by chance or by their own volatility, and the checks against a part's own history and the stricter bar inside a flat week do not catch all of them. It is the main thing standing between this pack and *calibrated*, and it is a finding of this step, not something this step fixes.

**Recorded incidents.** All three were found (hit rate 3 of 3). **They are not independent evidence**: the analysis was developed against both real incidents (they motivated sprint 3 and are in the regression suite), and the one for the timely rate is in it too. The tool marks the second volume incident as kept aside by default, which here is only nominal. So no pack of these two reaches *verified*: complaints cannot (no independent evidence, and fault injection is not available on cloud data), and the contact-centre pack did, on synthetic data.

### Where this leaves Phase 2's done-when
- **One pack reaches `verified` through the full ladder:** yes, the synthetic contact-centre pack, one seed end to end through the real server (rates over 8 seeds above). Not a real-data pack.
- **False-alarm and hit rates published for two packs:** yes, both with counts and intervals. The real-data pack does not pass the calibration standard, and the numbers say so.

### Not shown
- Whether the contact-centre results hold on any real data: the synthetic data has steady noise, which is what the analysis' tests assume.
- The complaints rates come from 20 chosen periods per KPI (the interval is wide: 20% to 61% for volume after labelling), from one dataset, with labels from one independent reviewer, not from the person; the early years of the database (2011 to 2013, when it was small and growing) are in the sample.
- The sizes at which planted faults are found depend on how a fault is built; mix shifts between parts were not measured; faults on cloud data were not planted.
- One run of the whole ladder; no rate for how often a person gets through it.
- A live assistant planting faults (it did not in the one live run), and any rate of how often a model follows the guide; the one live run is described above.

### One live conversation (Claude Code with the plugin, a simulated analyst, the analyst's own files)

`scripts/live-data.mjs` makes 16,800 parcel deliveries (30 weeks, four regions, an on-time flag) with two real incidents of known cause (a depot strike in the north in week 12, a motorway closure in the east in week 23) and a simulated analyst whose every report number is computed from the file, so any week, region or day the assistant asks about is answered truthfully. `scripts/build-conversation.mjs --no-pack` then ran one conversation, 12 turns, **$0.54 for the assistant** ($0.44 for the simulated user). The project the run left behind was read and compared with what the assistant said.

**What the assistant did (graded against the build guide):**
- Asked the prep-card questions one at a time, **including the past-incident question** (the one skipped in the earlier live run), and the access question; connected the file, described the business, saved it and read it back for agreement; asked before using the three numbers the person gave, then reconciled against them (three numbers, three kinds, two periods).
- Replayed the history with `calibrate` and said the tool's own sentence and numbers; asked about the two flagged weeks **one at a time**, in plain words, and recorded each answer with `label_period`; did not argue the numbers away.
- Proposed the two incidents with `propose_incident`, read them back, and recorded them only after the person agreed; said the first can help set the analysis up and the second "I'll keep aside and only look at it at the end ... I won't adjust anything to make it pass".
- Ended by saying the KPI was **verified**, with the false-alarm result and its honest upper end ("could still be as high as about 1 in 7" with only 24 judged weeks), and **"Verified rests on one incident that was kept aside, and the one incident can't prove the analysis on its own"**.
- Showed the person no path, tool name, YAML or SQL; stated no figure of its own arithmetic (the one derived phrase, "about seven months", is a plain reading of the dates).

**What the project recorded (checked against what it said):** the KPI at *verified*; three confirmed numbers (a week, a region, a day, each from a named report); calibration 0 of 24 ordinary weeks after the two weeks the person called real were left out (2 of 26 had raised something, exactly the two planted incidents); the first incident marked as able to help and the second kept aside; the check of the expert found both (hit rate 1, 1 of 1 kept aside). A `save_pack` between recording the incidents and checking them re-saved the same description with the expert added; it did not change the KPI (its calibration stayed valid), so it was not tuning.

**What it did not show.** The assistant did not use `inject_faults` (the guide asks for it when there are no incidents or one; here there were two), so planting faults has still not been driven by a model. One conversation is one run: no rate, and it says nothing about people. The data is synthetic with steady noise and two clear incidents. Harness quirks that are not product behaviour: the opening line was cut to "Hi." (an argument-splitting slip in how the run was started) and the simulated analyst gave all three numbers at once where its notes said one at a time. The earlier faults (the skipped incident question, a number the assistant worked out itself) did not recur in this run, which is one observation and not proof they are fixed.

### Regression after step 5 (from PowerShell, one run)
Build and unit tests in every package (0 failures), purity and ladder checks, contact-centre eval **25/25**, routing **38/38**, intents **16/16**, integration **8/8**, complaints eval on real BigQuery **7/7**, and the Claude Desktop extension, single-executable and engineer-path proofs all pass (the tool list had grown since they last ran). Nothing else in the analysis changed in this step; the only code changes were the spread option, the planted-size option and a `verify_expert` message that read backwards.
