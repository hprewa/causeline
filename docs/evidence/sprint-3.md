# Sprint 3 evidence: analysis depth

What each step shows and, as important, what it does not. The plan is in the sprint's step table in `PROGRESS.md`. The sprint comes from what
sprint 2's real data exposed: two real incidents the analysis misses (`packs/complaints/evals/known-gaps.md`), findings reported in weeks that
were only noise, and a data-quality guard that stops ordinary weeks.

## Step 1: reproduce, and a way to say "expected to fail today"

**Question:** can the shapes that failed on real data be reproduced at synthetic scale, in tests that fail today for the stated reason and
cannot be forgotten once fixed?

**What was built**
- **`gap` on an eval case** (`core/schema/src/evalcase.ts`, `core/eval/src/table.ts`): a case with `gap: "<why>"` is reported as `gap` while it
  fails and does not fail the run; if it starts to pass it is reported `GAP CLOSED` and **fails the run** until the marker is removed. The table
  counts them apart (`runner score: 20/20 (and 2 known gaps, 2 still open)`) and lists each gap with its reason. 3 unit tests.
- **Planted faults in the contact-centre generator** (`packs/contact-centre/data/generate.py`; existing seeds and faults unchanged):
  `surge_all` (a thin rise across every node), `star_agent`, `bad_week`, `funnel` (a share of every other agent's calls to one agent, at its
  own or a given rate), `noisy_volume` and `noisy_rate` (week-to-week noise beyond counting noise, for everything or for each queue or team on
  its own) and `ramp_down` (the newest weeks hold only part of their calls).
- **Four new cases** in `packs/contact-centre/evals/cases.yaml` (22 in all):

| Case | The shape | Today |
|---|---|---|
| `contributor_below_the_drill_share` | one queue explains 51% of a rise in volume, the rest spread thinly: no child reaches the drill share (0.6) | **gap** (path: "no child dominates (largest explains 51%): systemic"; nothing reported) |
| `quiet_week_with_noisy_volume` | each queue's weekly volume moves 12% on its own: a quiet week | **gap** (findings are reported) |
| `share_shift_to_one_agent` | a quarter of a week's calls go to one agent whose rate rises | passes (found through the hierarchy); kept as a regression for step 4 |
| `newest_week_still_arriving` | the newest week holds 85% of its calls | passes **for the wrong reason**: one agent of sixty falls under half its usual rows by chance and the flat guard stops the run |

- **A unit fixture for the real mix failure** (`core/runner/test/mix-gate.test.ts`, marked `todo`): 4 companies and 60 with three baseline rows each, one company
  carrying 143% of the change; rate and mix totals are 10 times the change and opposite in sign, and the mix gate names a thin node.

**What the trace of the real Equifax timely-rate case showed** (a probe that prints the drill path; recorded in `known-gaps.md`, which had a wrong
claim about the company's baseline and is corrected): at the company level the rate part of the change was +0.129 and the mix part -0.095 against a
change of +0.033, because hundreds of companies have a handful of rows in the baseline and a baseline rate of 0% or 100% by chance, which makes each
one's rate effect and mix effect large and opposite. The mix gate fired on that total and chose the node with the largest mix effect (a thin one). So
the failure is not "no mix attribution"; it is an unstable split. The plan's step 4 is changed accordingly (below).

**Evidence**
- Every package's unit tests pass (the runner's reports one `todo`: the mix fixture), purity OK.
- Contact-centre eval: `runner score: 20/20 (and 2 known gaps, 2 still open)`; routing and intents are untouched by this step.

**Not shown**
- The synthetic data cannot reproduce the real mix failure end to end (the contact-centre has no flat dimension of hundreds of values, and the agent
  hierarchy finds the shifted agent). That case is a unit fixture plus the real complaints data on BigQuery, not a planted-fault eval; the plan said
  planted faults "at synthetic scale" and this one is only partly met.
- The ramp-down case does not yet fail; it will after step 5 makes the guard statistical, and gets its marker then.
- Nothing about the analysis changed in this step.

**Plan adjustments:** step 4 becomes "stabilise the rate and mix split for thin baselines, require the mix to point the way of the change, choose the culprit
by contribution" (the cause found), with per-node mix attribution only if the real case still needs it afterwards; the ramp-down case's gap marker is
added in step 5, not step 1.

## Step 2: contributions core (no change to which findings are reported)

**Question:** can every deep dive say, deterministically, who contributed how much to the change and whether that is usual for them, without touching what is reported as a finding?

**What was built**
- **`core/runner/src/contributions.ts`** and a `contributions` step at the end of `metric_change` (before evidence). From the splits the drill already looked at (a hierarchy's first
  level, a diluted sweep, a flat dimension over the whole window) it takes the biggest contributors in the change's direction (each at least a tenth of the change, two a split,
  five in all), and for each works out **its contribution in the KPI's own units, its share of the change, its rate effect and mix effect** (the formula `decomposeRatio` uses; for a
  total, the node's amount less its share of the baseline's average period) for this period and for **up to eight earlier periods, each against its own baseline**. The verdict:
  `new` (under min_volume rows a period in the baseline), `unusual` (outside everything seen earlier **and** at least three robust standard deviations from the median), `usual`, or
  `unknown` (under four earlier periods). It also reports the share of the change that one level's reported contributors account for, and what is left.
- **`result.json`** gains `contributions[]` and `explained` (`core/schema/src/result.ts`, additive; the JSON schema is regenerated). **No finding, path or flag changes**: a test runs
  the same fault with and without the step and compares findings and path; every contact-centre case gives the same outcome.
- **Cost:** one day-level series query per node reported, at most five, shown as steps tagged `contributions`. The history needs eight earlier windows: a date range used to build only
  nine windows (the baseline and its like-for-like reach), so it now builds `baseline + 8` earlier ones (free: they come from the day series already read) and the history is eight periods, not four.
- **Budgets:** the Builder's budget is now 50 passes of what one pass reads (was 40; a deep dive is 15 to 35 queries plus up to five for this step), and the complaints pack says 40 GB.

**Evidence**
- 9 new unit tests (`core/runner/test/contributions.test.ts`): contributions add up exactly to the change and equal `decomposeRatio`'s per node; the total's formula; the verdict rules (usual,
  a small excursion that is still usual, unusual, new, unknown); day rows summed into periods by their timestamps; candidate selection; a planted fault through the runner (the node is `unusual`
  with 5 to 8 periods of history, rate plus mix equals the contribution, the explained share and at most five queries); clean data reports nothing unusual or new; too little history gives `unknown`;
  a total (volume) is attributed the same way.
- Contact-centre eval: `runner score: 20/20 (and 2 known gaps, 2 still open)`, each case five queries longer; routing 27/27; intents 16/16; integration 7/7; every package's unit tests; purity OK.
  Complaints eval on BigQuery: **5/5**, unchanged.
- **On the real incidents** (BigQuery, traced with a probe that prints the contributions):
  - Wells Fargo week of 12 September 2016: `WELLS FARGO & COMPANY` contributes +190 complaints, **42% of the change, `unusual`** (typical +9, range -19 to +125 over eight weeks), next to the product
    "Bank account or service" (`unusual`) and "Mortgage" (`usual`: it often contributes this much). The analysis still reports only the web channel as a finding; step 3 reports contributors like this one.
    The web channel's contribution, 480 (105%), is `usual` against eight weeks of a very variable channel.
  - Equifax week, timely response rate: `EQUIFAX, INC.` contributes +0.0134 of a +0.0149 change against the pooled baseline (the headline's seasonal baseline gives +0.0208) (**90%, `unusual`**), mostly by rate (+0.0153) with a small negative mix (-0.0019).
    The findings still name the product, a day and the wrong company; the contributions table has the right answer.
  - Equifax week, complaint volume: Equifax +5,215 (109%, `unusual`), the credit reporting product, the web channel, the issue "Improper use of your report", and the state CA (+1,042, 22%, `unusual`).
  - Cost with the step: Wells week 24 queries, 14.8 GB (about $0.08); Equifax volume week 45 queries, 28.2 GB (about $0.16, inside the new 40 GB).

**Not shown**
- The history uses a plain pooled baseline of the periods just before each earlier one, not the seasonal like-for-like baseline the headline uses. For weekly periods the weekday mix is the
  same so this is close; for a date range of a few days it is approximate. A node is judged against periods that include earlier incidents, so a node that has often had incidents reads `usual`.
- Only the biggest contributors of splits over the whole window are reported; contributors inside a drilled node (a company within a product) are not (it would cost a history query per node and parent).
- The explained share picks the one level whose reported contributors account for the most; it is not a statement that the other levels explain less.
- The thresholds (a tenth of the change, three robust standard deviations, eight periods) were set from the unit tests and the planted data and looked at on the three real weeks above; none was tuned on them.
- Nothing uses the verdicts yet: findings are unchanged until step 3. The contributions are not yet in the agent's skill or answers.

## Step 3: report contributors when none dominates

**Question:** when a change is carried by one node without any node reaching the drill share (0.6), can the analysis still name it, without adding noise where nothing is concentrated?

**What was built** (`core/runner/src/contributions.ts`, a `contributors` step after `contributions` in `metric_change`)
- A contribution becomes a **finding with `role: "contributor"`** when all of these hold:
  1. the headline change is real (significant);
  2. the concept it belongs to has **no finding yet** (a finding on a node covers every level of its hierarchy, and a scoped finding covers the concept of its scope), so a drill that already found a deeper node is not repeated by its ancestors;
  3. it carries at least `contributor_share` of the change (default 0.25, a new pack-tunable threshold) **and at least 1.5 times its own size's share** of it (new field `baseline_share` on a contribution), so a rise spread evenly over every node is nobody's;
  4. its verdict is `new` or `unusual` against its own eight earlier periods;
  5. at most three a level.
- Its impact is its contribution in the KPI's units, so it ranks with the other findings; its effect is `mix` when the mix part of its contribution is larger than the rate part. `Finding` gains an optional `role`.
- Rule 2 exists because the first design (any qualifying contributor) would have added a centre or a site above every drilled team and, being bigger, ranked above the team the drill found; the
  existing cases that ask for the top finding would have failed.

**Evidence**
- 5 new unit tests: the selection rules one by one (a big node, the node that is merely big, the usual node, the small share, a new node; no contributors when the change is not real or the concept already has a finding; the per-level cap), and through the runner: a flat dimension where one value carries 56% of a rise (so not drilled) reports it as a contributor and the other findings are untouched; a rise spread evenly over every node reports none.
- **Planted case** `contributor_below_the_drill_share` (queue `billing` carries 57% of a rise in volume; the rest is thin; sixteen weeks so the history exists): was a known gap, **now passes** and its `gap` marker is removed. Without the step nothing was reported.
- **Every other contact-centre case is unchanged** (21/21, 1 known gap still open); routing 27/27, intents 16/16, integration 7/7, every package's unit tests, purity OK.
- **The real Wells Fargo case now passes on BigQuery** and moves from `known-gaps.md` into `packs/complaints/evals/cases.yaml`: findings for the week of 12 September 2016 are the web channel, **`WELLS FARGO & COMPANY` (contributor, 42% of the rise, unusual against eight earlier weeks)** and the product "Bank account or service" (contributor, unusual); 25 queries, 15.3 GB, about $0.09. Complaints eval: **6/6**.

**Not shown**
- The thresholds (a quarter of the change, 1.5 times its size, at most three) were chosen from the unit tests and the planted case, and looked at on the three real weeks of step 2; none was adjusted after seeing the Wells Fargo case pass.
- The quiet-week complaints cases still report findings from the older mechanisms (changes inside a week that cancel out); the contributors rule adds none there because their headline is not significant, but that noise is step 5's.
- In the planted case only the billing queue is reported; the centre and site contributions read `usual` because the sixteen weeks include the generator's peak week and holiday, which widen every node's history. A short or very variable history makes contributors rarer, not wrong.
- A contributor is a node that carries an unusual part of a real change; it is not a cause. The answer still has to say so (the investigate skill does; step 7 adds the table to it).
- The Equifax mix case still fails (step 4), and the quiet-week noise remains (step 5).

## Step 4: stabilise the rate/mix split

**Question:** why does the analysis miss that one company that answers on time absorbed most of a week's volume (Equifax, timely response rate), and can the fix leave every other case alone?

**Cause (traced):** a company with a few baseline rows has a baseline rate of 0% or 100% by chance. Taken at face value its rate effect and its mix effect are each large and opposite; added over hundreds of such companies the rate total (+0.129) and mix total (-0.095) dwarf the change (+0.033), and the mix gate fired on the opposed-sign total and named the company with the largest mix effect, a thin one.

**What was changed**
- `decomposeRatio` and the contributions take the whole's baseline rate for a node whose baseline holds fewer than `min_volume` rows, **in the rate/mix split only**; a node's contribution still uses its real baseline rate, so contributions add up exactly to the change.
- The mix gate fires only when the mix total points the same way as the change.
- The culprit is still chosen by mix effect once the gate fires; with thin baselines stabilised the right node has it.

**Evidence**
- Unit fixture `core/runner/test/mix-gate.test.ts` (the shape of the incident: one node carrying the change among 60 thin ones): the todo became a passing test; totals are of the order of the change; contributions sum exactly; an opposed mix is not called mix.
- Runner tests, contact-centre eval 21/21 (1 known gap), routing 27/27, intents 16/16, integration 7/7, purity OK.
- Real data (BigQuery): `equifax_week_timely_rate` passes (Equifax is the first finding, 32 queries); `equifax_breach_volume` and `wells_fargo_sales_practices_volume` still pass. The case moves from `known-gaps.md` to `cases.yaml`.

**Not shown**
- The other four complaints cases (three quiet weeks, the week after the data ends) were **not re-run after this change**: Google credentials expired (`invalid_rapt`) during the run. They are unaffected in the unit and contact-centre evals, but this is unverified on BigQuery until re-authentication.
- The synthetic generator cannot reproduce the real failure (it needs hundreds of thin companies); the unit fixture and the real data carry the evidence.

