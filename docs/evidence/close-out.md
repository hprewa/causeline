# Close-out after sprints 3 and 4

## 1. Parity and cost on both databases: not complete
- SQLite: all 25 contact-centre cases pass (25/25, 4/4 playbook branches taken).
- BigQuery: **not run to the end.** The run was stopped by the system because the machine was low on memory. No BigQuery result file exists for the 25 cases, so parity after the depth sprints is **not shown** and cost per case is not re-measured. It needs a re-run when the machine has room (it prepares one dataset per case).

## 2. Live agent on the new result shapes: done
Three cases through a live Claude Code agent (`--agent claude-code --no-bare`, about $0.15 to $0.25 a case, 7 turns each).
- **First run: the agent saw old results.** The plugin bundle under `clients/claude-code` is built by `npm run bundle:plugin` and had last been built before sprint 3's depth work, so the agent ran an old server and an old skill: it said "no single driver stands out" for the billing contributor, suggested "check whether calls offered was up" instead of reading the hand-off, and ran the `trend` playbook for a recovery question. Lesson: **rebuild the bundle after any change to the runner or the skill before a live run**; a stale bundle looks like an agent mistake.
- **After rebuilding:** all three read the new fields correctly: the billing queue named as an `unusual` contributor with its share and history; the hand-off to `calls_offered` explained ("because no part of the service-level data itself explained the drop, the playbook checked the KPIs it depends on"); recovery stated from the `after` field.
- **Two checks failed on rounding** (82.9 written for 82.96; 4.9 for a figure the result holds differently). The skill now says to round to the nearest and to quote figures the result gives rather than subtracting. **Rerun of those two cases: agent 2/2.** The first case passed in both runs.
- **Not shown:** more than one run per case (the agent is not deterministic); the agent on BigQuery data; the complaints incidents.

## 3. Why the Wells Fargo case runs 43 queries instead of 25
Traced with the probe on the real week (12 to 18 September 2016), 43 queries, 26.9 GB, about $0.15.
- At sprint 3 step 3 the drill did not treat the product and issue levels as masked. Now the path shows `product: Bank account or service masked | parent looks flat but one child is significantly worse` and the same for the issue level, each followed by drills into company, state and channel inside them. These extra drills are the added queries.
- The flags say "parent change is not significant (z=2.0)" while the headline for the same week has z=6.4. The window-level z used in the drill is now computed with the extra variation of sprint 3 step 5, which pulls it to the edge of the threshold (2.0), so the masked branch fires. The headline z uses the seasonal expectation and is not adjusted.
- **Likely cause, not isolated:** no A/B run with the adjustment switched off was made. The result is still correct (the company and the channel are found, the explained share is 100%) but the findings list repeats the company inside two products.
- **Open defect (goes to calibration, phase 2):** the "parent looks flat" test and the headline significance disagree. One decision about whether a change is real should feed both.

## 4. Branch coverage enforced by default: done
- The gate is now **on by default** (`--no-branch-gate` turns it off; the report is printed either way). It fails the run when an expert marked verified has a playbook branch no passing case takes.
- A branch a pack cannot reach is **not applicable**, not untested: the hand-off step's run branch when no KPI in the pack declares parts. The report lists it as "not applicable to this pack". (Alternative considered: invent a KPI tree for the complaints pack to test it; rejected, it would be a fiction.)
- Contact-centre: 4/4, run passes (25/25). Complaints on BigQuery: 7/7, 3/3 applicable branches, 1 not applicable, run passes.
- **Not shown:** that a pack with a reachable but untested branch fails (covered by a unit test of the flagging, not by a failing real run).
