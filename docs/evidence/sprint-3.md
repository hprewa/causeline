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
