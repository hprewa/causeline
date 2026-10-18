# Playbook language: audit against the decision-graph requirements

Scope: `core/schema/src/playbook.ts`, `core/runner/src/runner.ts`, `steps.ts`, `drill.ts`, `product.ts`, the four
shared playbooks (`metric_change`, `value`, `trend`, `compare`). Report only; nothing here is implemented yet.

## What exists

- A playbook is an ordered list of steps. Each step names a compute function (plain TypeScript in `core/runner`)
  or an evidence lookup. Steps may be scoped with `over` (`time` | `hierarchies`) and `within` (an earlier step).
- Control flow is limited to: run steps in order; any step may set `ctx.stop` (a stop reason and detail), which
  ends the run; a product-type KPI is analysed through `runProductMetric`, which re-enters the runner once for the
  dominant driver (`recurse`).
- Loops (drilling level by level, sweeping deeper levels) live inside compute functions (`guided_drill`).
- `result.path` records the drill's moves (node, decision, reason). `result.steps` logs every tool call.
- Schema validation checks unique step ids and that `within` refers to an earlier step.

## Gaps against the required capabilities

| # | Capability | Today | Gap |
|---|---|---|---|
| 1 | Named facts published by each step | Steps write into one shared `RunContext` | No fact registry; a later decision cannot reference `where.decision` or `dq.coverage` by name; no way to validate that a fact exists before use |
| 2 | Branching with ordered `next` rules | None; strictly linear | No `next`, no `else`, no skip-ahead, no hand-off to another KPI expert from a playbook (only the product special case) |
| 3 | Conditional steps (`when:`) | None | A step always runs unless the run has stopped |
| 4 | Bounded loops | Loops hidden inside `guided_drill`; depth bounded by hierarchy length | A playbook cannot declare or see a loop or its maximum; no runner-level step budget |
| 5 | Parallel branches and merge | None | E.g. investigating both parts of a two-part KPI is not expressible |
| 6 | Fallback to the Explorer | None | A run that matches nothing just ends |
| 7 | Safe expression language for conditions | None | Needs a small evaluator: comparisons, and/or/not, membership; no code, no model |
| 8 | Decision steps for judgement | None | Needs an explicit step type with a fixed option list, whose choice and reason are logged |
| 9 | Validation | ids unique, `within` earlier | No unknown-step references, unreachable steps, facts-used-before-produced, loops without a maximum |
| 10 | Recording | `path` holds drill moves only | Does not record every step run, the facts it produced, which rule fired and why, or the branches not taken |
| 11 | Branch-coverage evals | Eval cases score outcomes | No notion of a branch; no report of untested branches; nothing blocks `verified` on a playbook with untested branches |
| 12 | Authoring by conversation | The Builder writes KPIs, facts and experts | No way to capture "after X, what do you check if A, and if not?" and no flowchart view |

## Proposed design (for the depth sprint)

**Step shape.** Keep one step type with optional `next`:

```yaml
- id: where
  compute: guided_drill
  over: hierarchies
  publishes: [decision, main]          # facts this step makes available as where.decision, where.main
  next:
    - if: where.decision == "broad"    then: split_component
    - if: where.decision == "masked"   then: where_deeper
    - else: who
```

`then` accepts a step id, `stop: <reason>`, `handoff: <expert>` or `fallback: explorer`. Absence of `next` means
"the following step", so the existing four playbooks keep working unchanged.

**Facts.** Each compute function declares the fact names and types it publishes. The runner keeps a `facts` map
keyed `<step>.<name>`; a condition may only read facts that some earlier-reachable step publishes (checked at load).

**Expressions.** Grammar: literals (number, string, boolean), fact references, `== != < <= > >=`, `and or not`,
`in [..]`. Parsed once at load into a small AST and evaluated by code. No function calls, no assignment.

**Bounds.** A step reachable more than once must declare `max_visits`; the runner also enforces a total step
budget (default 40). Exceeding either stops the run with a stated reason rather than looping.

**Decision steps.** `decide: { options: [a, b, c], prompt: "..." }` is the only place a model is consulted; the
choice and a short reason are written to the record. Marked `judgement: true` in the result.

**Record.** `result.trace[]`: `{ step, facts, rule_fired, because, skipped: [rules not taken] }`, replacing `path`
as the full audit trail (`path` stays as the drill detail inside a step).

**Validation (load time).** Unknown step ids; unreachable steps; reads of unpublished facts; revisitable steps with
no `max_visits`; `next` lists with no terminal `else`; hand-offs to experts that do not exist in the pack.

**Evals.** The eval report lists every `next` rule of every playbook with the cases that fired it; a rule with no
case is "untested", and an expert whose playbook has untested rules cannot be marked `verified`.

**Migration.** `metric_change` becomes: data check (`stop` on a data-quality fact), headline, trend check, `where`
with `broad`/`masked`/`drill` branches, `who`, then evidence. `value`, `trend` and `compare` need no `next`.

## Order of work

1. Fact registry and the trace (no behaviour change; existing evals must be identical).
2. Expression evaluator with property tests; load-time validation.
3. `next`/`then`/`else`, `when`, bounds and the step budget.
4. Decision steps and hand-off between experts.
5. Branch coverage in the eval report and the `verified` gate.
6. Builder capture and the flowchart view.
