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

