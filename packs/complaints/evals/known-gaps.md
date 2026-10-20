# Real incidents the analysis does not yet get right

These were written as eval cases, run on the real data, and failed. They are not in `cases.yaml` (which says what works). Each says what
was expected, from what outside the data, what the analysis said instead, and what would have to change. Run them by hand with
the `run_playbook` tool (`metric_change`, with `start_date` and `end_date`) on this pack.

## Wells Fargo, week of 12 September 2016 (complaint volume): closed in sprint 3, step 3
The analysis now reports `WELLS FARGO & COMPANY` as a contributor (42% of the rise, unusual against eight earlier weeks); the case is in `cases.yaml`.

## The Equifax week, timely response rate
- **Expected:** the overall timely response rate rose from about 98.1% to 99.4% in the week of 4 September 2017 because most of the week's
  complaints (61%) were about one company, Equifax, which answered 100% of them on time; the analysis should name Equifax. (In the data
  Equifax answered on time 100% of the time in nearly every week; one baseline week, 14 August, was 89.9%, which pulls its four-week
  baseline down to about 97.5%. So the case is "one company that answers on time absorbed most of the volume", not "its own rate did not
  move"; an earlier version of this note said the latter and was wrong about the baseline.)
- **Got:** a finding on the credit reporting product (effect `rate`), the day 8 September, and `WELLS FARGO & COMPANY` with a tiny `mix`
  effect; Equifax is not named.
- **Why (traced in sprint 3):** at the company level the analysis splits the change into a rate part and a mix part: rate +0.129 and mix
  -0.095 against a change of +0.033. The numbers are large and cancel because hundreds of companies have a handful of rows in the baseline:
  a company with three baseline rows has a baseline rate of 0% or 100% by chance, so its rate effect and its mix effect are each large and
  opposite. The mix gate then fires on the (opposite-signed) total and names the company with the largest mix effect, a thin one, not the
  one that carries 76% of the change. The fixture `core/runner/test/mix-gate.test.ts` reproduces it.
- **What would change it:** stabilise the split for nodes whose baseline is thin (use the parent's baseline rate for them, as for a node
  absent from the baseline), require the mix to point the same way as the change before the gate fires, and choose the culprit by
  contribution. Sprint 3, step 4.
