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

