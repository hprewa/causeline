# Real incidents the analysis does not yet get right

These were written as eval cases, run on the real data, and failed. They are not in `cases.yaml` (which says what works). Each says what
was expected, from what outside the data, what the analysis said instead, and what would have to change. Run them by hand with
the `run_playbook` tool (`metric_change`, with `start_date` and `end_date`) on this pack.

## Wells Fargo, week of 12 September 2016 (complaint volume): closed in sprint 3, step 3
The analysis now reports `WELLS FARGO & COMPANY` as a contributor (42% of the rise, unusual against eight earlier weeks); the case is in `cases.yaml`.

## The Equifax week, timely response rate: closed in sprint 3, step 4
Hundreds of companies with a handful of baseline rows made the rate and mix parts large and opposite, so the mix gate named a thin company. Thin baselines now take the whole's rate in the split and the mix gate needs the mix to point the same way as the change; the case is in `cases.yaml` and names Equifax first.
