# Sprint 4 evidence: playbooks that branch, and hand-offs between KPIs

Design: `docs/audit/playbook-language.md`. Each step is a commit; what was and was not shown is listed per step.

## Step 1: fact registry and a full trace (no behaviour change)

**Question:** can the run record, for every step, what it found, under names a later condition can read, without changing any answer?

**What was built**
- `core/runner/src/facts.ts`: after each step the runner publishes named facts (`<step>.<name>`, e.g. `headline.significant`, `headline.direction`, `where.found`, `where.decision`) into the run and appends a `trace` entry. `FACTS` lists the facts each kind of step may publish; it is what conditions will be checked against when a playbook loads.
- `result.json` gains `trace[]`: `{ step, compute, facts, rule?, because?, skipped[] }`. `rule`, `because` and `skipped` are for step 3 (branching) and empty now.

**Evidence**
- 3 new unit tests: the trace lists every step in playbook order with the facts it published; a stopped run's trace ends at the step that stopped it; every compute step declares its facts.
- Nothing else moved: all unit tests, contact-centre eval 22/22, purity OK.

**Not shown**
- No condition reads a fact yet (steps 2 and 3). The routing, intents and integration suites and the BigQuery evals were not re-run for this step (the change only adds output).

## Step 2: a safe condition language and load-time validation

**Question:** can a playbook say "if this was found, do that" in a form that can be checked before anything runs and cannot execute code?

**What was built**
- `core/schema/src/condition.ts`: a small language over published facts: numbers, words, yes/no, `null`, `step.fact` references, `== != < <= > >=`, `in [..]`, `and`, `or`, `not`, brackets. It is parsed once into a tree and evaluated by code; nothing in it can invoke a function or assign a value. A fact nobody published reads as `null`, and ordering with `null` is false.
- Playbook steps accept `when` (run only if it holds), `next` (rules `if`/`then`, closed by an `else`; a target is a step, `{stop: reason}` or `{handoff: kpi}`) and `max_visits`. The schema checks syntax, that targets are steps, and that the last rule is an `else`.
- `checkPlaybook` (runner, called whenever a playbook is loaded) checks that a condition reads only facts that an earlier step really publishes (against the `FACTS` list of step 1), that a rule sending the run back names a target with `max_visits`, and that no step is unreachable.
- Nothing runs the new fields yet (step 3); the four shipped playbooks do not use them and pass the check.

**Evidence**
- 6 schema tests: every operator, null behaviour, the facts a condition reads, ten malformed conditions refused (assignment, a call, a bare word, a three-part name, an unclosed string...), rule structure.
- 4 runner tests: the shipped playbooks are sound; unknown fact, later fact and unknown step are named; a loop without `max_visits`; an unreachable step.
- All unit tests, contact-centre eval 22/22, routing 27/27, purity OK.

**Not shown**
- Hand-off targets are not checked against a pack's experts yet (step 4). There is no property-based test of the evaluator, only the cases above.

## Step 3: branching, conditional steps, loops with bounds

**Question:** can a playbook choose what runs next from what earlier steps found, with the route taken written down?

**What was built** (`core/runner/src/route.ts`, the run loop in `runner.ts`)
- The runner now walks the steps with a position instead of a plain list. A step with `when` is skipped (and the trace says so and why) when its condition does not hold. After a step, its `next` rules are tried in order; the first whose condition holds decides the next step, a `{stop: reason}` (ends the run), or a hand-off (step 4; until then the run stops with `handoff_unavailable`).
- Each trace entry records the rule that fired, the facts it read with their values, and the rules before it that did not hold.
- A step reached again may run only `max_visits` times (default 1): the next time the run stops with `loop_limit`. A run executes at most 40 steps: past that it stops with `step_budget`.
- `metric_change` uses `when: headline.significant` on its `contributors` step (a change that is not real has none; the step already returned nothing, so every result is identical).

**Evidence**
- 4 new runner tests: a rule ends a quiet run early and the trace names the rule and the fact values; the else branch continues and the rule that did not hold is recorded; a conditional step is skipped on quiet data and runs on a fault; a loop is limited by `max_visits` and stops with `loop_limit`.
- All runner tests 148/148, contact-centre eval 22/22 (identical), routing 27/27, intents 16/16, integration 7/7, purity OK.

**Not shown**
- No shipped playbook yet takes a branch that changes an answer. The only real use is the `contributors` condition, which does not change results. A branch that stops quiet runs early was **deliberately not** added to `metric_change`: its quiet-week cases and the offsetting planted case rely on drilling below a flat headline.
- The step budget (40) has no test of its own beyond the loop limit; the longest real run is 13 steps.
- BigQuery evals were not re-run for this step (the runner change is database-independent).

## Step 4: hand-off from one KPI to the KPIs it depends on

**Question:** when a real change is explained by nothing in the data's splits, can the analysis look at the KPIs the changed KPI is made of or driven by, instead of reporting nothing?

**What was built**
- The ontology's existing `children` (a KPI tree, declared since sprint 1 but unused) now has a use. A `handoff` step (`core/runner/src/handoff.ts`) analyses up to three of the KPI's `children` on the same period, scope and baseline, by running the same analysis again for each; a short account of each (headline, up to 5 findings, up to 5 contributions) goes into `result.json` as `handoffs[]`. A KPI already being analysed higher up is never analysed again; a hand-off goes at most two KPIs deep; an unknown KPI is skipped and the trace notes why. A rule `then: {handoff: <kpi>}` in a playbook does the same for one named KPI and ends the run.
- `metric_change` gains the step `parts`, run `when: headline.significant and where.found == 0 and flat.found == 0 and contributors.found == 0`: only when the change is real and nothing explained it.
- Contact-centre pack: `service_level` declares `children: [calls_offered]` (relation `driver`). New fault `degrade` (every call answered in time may go late: a uniform fall). Eval cases gain `handoffs_include` and `no_handoffs`.

**Evidence**
- **Planted case `service_level_falls_when_load_rises`** (call volume rises 30% and every call is a little less likely to be answered in time, alike on every queue, team and agent): the splits find nothing; the run hands over to `calls_offered` whose own change is real. Before this step nothing existed to express it.
- `understaffed_team` now asserts `no_handoffs` (the data explains it, so nothing is handed over) and passes.
- 3 unit tests for the hand-over (keeps an account; parts only, not an unknown KPI or itself; the chain limit). Contact-centre eval 23/23, routing 27/27, intents 16/16, integration 7/7, all unit tests, purity OK.

**Not shown**
- Only one planted shape (volume as a driver of a rate). No product-type KPI or complaints case uses it: the complaints pack declares no `children`, so its runs are unchanged; BigQuery evals were not re-run for this step.
- A hand-off costs a full analysis per part (about 20 queries each); there is no budget check for it yet beyond the database's own budget.
- The hand-off says where to look; it does not test that the part explains the change in the whole (no attribution of the whole's change to the part).
- The agent has not been run against a hand-off result; the skill text for it is untested.

