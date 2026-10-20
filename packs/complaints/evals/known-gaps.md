# Real incidents the analysis does not yet get right

These were written as eval cases, run on the real data, and failed. They are not in `cases.yaml` (which says what works). Each says what
was expected, from what outside the data, what the analysis said instead, and what would have to change. Run them by hand with
the `run_playbook` tool (`metric_change`, with `start_date` and `end_date`) on this pack.

## Wells Fargo, week of 12 September 2016 (complaint volume)
- **Expected:** a finding on `company_name = WELLS FARGO & COMPANY`. On 8 September 2016 the CFPB announced its action over Wells Fargo's
  sales practices; in the data, complaints about Wells Fargo went from about 190 a week to 311 (week of 5 September) and 404 (week of
  12 September), while all complaints went from 3,618 to 4,172.
- **Got:** one finding, `submitted_via = Web` (impact 480 on a change of 455); Wells Fargo is not reported.
- **Why, as far as it is known:** Wells Fargo explains about half of the week's rise (about 214 of 455), below the share one child must
  explain to be drilled into (`drill_share`, 0.6), and the rest of the rise is spread thinly over many companies. The analysis only
  reports a culprit that stands out as most of the change.
- **What would change it:** reporting the largest contributors to a change even when none passes the drill share (the "contributions
  vs history" item in the sprint 3 plan), not a threshold change for this pack.

## The Equifax week, timely response rate (a change in mix, not in rate)
- **Expected:** the overall timely response rate rose from about 98.1% to 99.4% in the week of 4 September 2017, and the analysis should
  say that this is mostly volume moving to a company that answers on time, with Equifax named. In the data: Equifax answered 100% on time
  (as it had before), every other company together moved only from about 98.0% to 98.4%, and 61% of the week's complaints were about Equifax.
- **Got:** a finding on the credit reporting product (effect `rate`), the day 8 September, and `WELLS FARGO & COMPANY` with a tiny
  `mix` effect; Equifax is not named, and the product-level finding is labelled a rate change.
- **Why, as far as it is known:** mix and rate are separated one level at a time. Inside the credit reporting product the shift is
  between companies, which the product level sees as a rate change; and at the company level Equifax's own rate did not change, which
  leaves no rate finding for it, while its mix effect is not carried up to a finding.
- **What would change it:** attributing a mix effect to the node that moved the share (Equifax) at every level of a drill, and saying
  which part of a change is mix when the culprit's own rate did not move.
