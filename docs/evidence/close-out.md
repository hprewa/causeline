# Close-out after sprints 3 and 4

## 1. Parity and cost on both databases: not complete
- SQLite: all 25 contact-centre cases pass (25/25, 4/4 playbook branches taken).
- BigQuery: **not run to the end.** The run was stopped by the system because the machine was low on memory. No BigQuery result file exists for the 25 cases, so parity after the depth sprints is **not shown** and cost per case is not re-measured. It needs a re-run when the machine has room (it prepares one dataset per case).

## 2. Live agent on the new result shapes: not run
Pending (needs the agent run; also memory-heavy).

## 3. Why the Wells Fargo case runs 43 queries instead of 25
Traced with the probe on the real week (12 to 18 September 2016), 43 queries, 26.9 GB, about $0.15.
- At sprint 3 step 3 the drill did not treat the product and issue levels as masked. Now the path shows `product: Bank account or service masked | parent looks flat but one child is significantly worse` and the same for the issue level, each followed by drills into company, state and channel inside them. These extra drills are the added queries.
- The flags say "parent change is not significant (z=2.0)" while the headline for the same week has z=6.4. The window-level z used in the drill is now computed with the extra variation of sprint 3 step 5, which pulls it to the edge of the threshold (2.0), so the masked branch fires. The headline z uses the seasonal expectation and is not adjusted.
- **Likely cause, not isolated:** no A/B run with the adjustment switched off was made. The result is still correct (the company and the channel are found, the explained share is 100%) but the findings list repeats the company inside two products.
- **Open defect (goes to calibration, phase 2):** the "parent looks flat" test and the headline significance disagree. One decision about whether a change is real should feed both.

## 4. Branch coverage enforced by default: not done
Pending. The complaints expert still lacks a branch it cannot reach (no KPI tree in that pack).
