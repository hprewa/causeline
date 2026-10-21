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
