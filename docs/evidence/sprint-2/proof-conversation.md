# The proof conversation: from an empty folder to verified KPIs and an investigated question

Run 6 of the complaints build conversation (the earlier runs and what they found are in `docs/evidence/sprint-2.md`). A Claude Code agent with the Causeline plugin and a simulated user told only what `packs/complaints/evals/build-persona.md` says; 25 turns; the agent's session cost **$1.99**, the simulated user **$0.85**. The 26th turn of the run was cut off by a usage limit and is left out. Agent text is cut at 1,800 characters a turn; the tools each turn called are listed.

## Turn 1

**User:** Hi. I'd like to look at consumer complaints data and understand why the numbers move. Can you help me set that up?

**Agent** (tools: Skill, ToolSearch, build_status):

> Fresh start - nothing connected yet. To get going, could you share the path to your consumer complaints file (or files)? You can paste the full file path, or drag and drop it here if your setup supports that.

## Turn 2

**User:** It's not a local file. The data is in BigQuery - the table is `bigquery-public-data.cfpb_complaints.complaint_database`. My project for billing is `yukti-dev`.

**Agent** (tools: ToolSearch, connect_bigquery, ToolSearch, describe_data):

> That read about 128 MB - roughly a tenth of a cent.
> 
> Here's what I found. A few things to note first:
> 
> - The data covers **December 2011 to March 2023** - it looks like a fixed snapshot, not a live feed, so "last week" will always mean the last week it holds.
> - The free-text complaint narrative was skipped (it'd be expensive and doesn't help with where/when analysis).
> - There are **3.4 million complaints**, one row each, with a unique complaint ID.
> 
> There are two questions I need your help with before I go further.
> 
> **First:** There are two dates on every complaint - when it was *received* by the CFPB, and when it was *sent to the company*. Which one matters for your reports? (My guess is `date_received` - the day the complaint came in - but let me know.)

## Turn 3

**User:** Yes, date received is the right one.

**Agent** (tools: none):

> **Second:** The data has both a `product` (18 categories, like "Debt collection" or "Mortgage") and a `subproduct` (76 more specific types under those). The catch is that some subproduct names like "Other" appear under several different products, so they're ambiguous on their own.
> 
> Would you like to use subproduct in your analysis? If yes, I'd combine it with the product name to make each one unique - so it'd read as "Mortgage > FHA mortgage" rather than just "FHA mortgage". Or we can stick with just the top-level product if that's enough detail.

## Turn 4

**User:** Yes, combining them makes sense. Same for issue and sub-issue if those repeat too.

**Agent** (tools: none):

> Good call - I'll do the same for issue and sub-issue.
> 
> Now let's talk about what you actually want to measure. **What do you watch day-to-day with this data?** For example, some teams track the volume of complaints coming in, others care about how quickly companies respond, or how often consumers dispute the outcome.
> 
> What's the number you'd most want to understand when it moves?

## Turn 5

**User:** The main thing I watch is whether companies are responding on time - the share of complaints where they gave a timely response. Higher is better.

**Agent** (tools: none):

> Perfect. And do you have a name you use for this in reports - something like "timely response rate" or "on-time rate"? Any shorthand your team uses?

## Turn 6

**User:** We just call it the timely response rate. That's the main one, but there are two more things I watch as well.

**Agent** (tools: none):

> Got it. What's the second one?

## Turn 7

**User:** The second one is the share of complaints where the company closed it with monetary relief. We call it the relief rate.

**Agent** (tools: none):

> And the third?

## Turn 8

**User:** Just complaint volume - how many complaints came in. Lower is better.

**Agent** (tools: ToolSearch, test_fact, ToolSearch, save_pack, save_pack, ToolSearch, play_back):

> Here's what I've written down - let me know if any of it is off:
> 
> **About the data:**
> 1. Questions are asked about one week at a time, and a change can be narrowed down to day.
> 2. Products break down into sub-products (each sub-product belongs to one product). Issues break down into sub-issues the same way.
> 3. Any metric can also be split by company name, state, and how it was submitted (web, phone, etc.).
> 
> **The three metrics:**
> 
> 4. **Complaint volume** - total number of complaints received. Lower is better. (Also called: volume, complaints, complaint count.)
> 5. **Timely response rate** - share of complaints where the company responded on time. Higher is better. (Also called: timely response, on-time rate.)
> 6. **Relief rate** - share of complaints where the company closed with monetary relief. Higher is better. (Also called: monetary relief rate.)
> 
> **Other:**
> 7. No repeating patterns assumed yet - every period is compared against the plain average of prior ones. (We'll check this properly in a moment.)
> 8. Three analytical experts are set up, one per metric - all drafts until we verify them against a real past case.
> 
> Is all of that right?

## Turn 9

**User:** Almost - number 6 is off. Lower is better for the relief rate, not higher.

**Agent** (tools: save_pack):

> Updated. Here's the corrected line 6:
> 
> **Relief rate** - share of complaints where the company closed with monetary relief. **Lower is better.** (Also called: monetary relief rate.)
> 
> Everything else stays the same. Does that all look right now?

## Turn 10

**User:** Yes, that's all correct now.

**Agent** (tools: play_back, ToolSearch, propose_checks):

> Let's start with **complaint volume**. I'd like to check a few numbers against your reports, one at a time.
> 
> **First:** What does your report show for total complaint volume for the whole business during the week of **13-19 March 2023**? And which report are you pulling that from?

## Turn 11

**User:** From the CFPB's public complaint search site, that week shows 26,270 complaints total.

**Agent** (tools: ToolSearch, confirm_number):

> There's a gap here - your report shows 26,270 but we get 17,860, about 32% lower. Both numbers are on the table now.
> 
> A few things could explain this:
> 
> 1. **The BigQuery dataset may be a frozen snapshot.** The data ends on 23 March 2023, and the CFPB regularly updates their live site. That week might have had more complaints filed or updated after the snapshot was taken.
> 2. **Week definition** - does the CFPB site count weeks Monday-Sunday, or Sunday-Saturday? Our analysis uses Monday-Sunday by default.
> 3. **Filters** - does the CFPB search site include any types of complaints that might be excluded from the BigQuery dataset?
> 
> Do you know if the CFPB's public search site reflects more up-to-date data than what's in the BigQuery table? If the BQ dataset is an older extract, that would explain most of the gap - and it would mean the most recent weeks of the data are undercount across all three metrics.

## Turn 12

**User:** That makes sense actually. The CFPB only publishes complaints after the company responds or after 15 days, so the newest weeks are probably still filling in when the table was copied. Want to try an older week instead? I have numbers for the week of 7 to 13 November 2022.

**Agent** (tools: propose_checks):

> What does your report show for total complaint volume for the week of **7-13 November 2022**?

## Turn 13

**User:** That week shows 18,778 complaints. That's from the CFPB's complaint search site.

**Agent** (tools: confirm_number):

> That's a match - we get 18,783, you said 18,778. Essentially identical.
> 
> Complaint volume is now **provisional** (one confirmed number). To get to verified, I need one more from a different angle - for example, a specific product or company for that same week, or a single day. 
> 
> Do you have, from the same CFPB site, how many complaints came in for **Credit reporting** products during that week of 7-13 November 2022?

## Turn 14

**User:** Yes - for that week, credit reporting shows 15,311 complaints. That's from the same CFPB site.

**Agent** (tools: propose_checks, confirm_number):

> Exact match - 15,311 on both sides.
> 
> **Complaint volume is now verified.** Two independent checks, both from the CFPB search site, both matching.
> 
> Note for the other two metrics: we should use that same settled November 2022 window (or earlier) for checking, since the newest weeks are still filling in. Shall we move on to **timely response rate** next?

## Turn 15

**User:** Yes, let's do the timely response rate next.

**Agent** (tools: propose_checks):

> What does your report show for the **timely response rate across the whole business** for the week of **7-13 November 2022**? (As a percentage is fine.)

## Turn 16

**User:** That week shows 99.46% timely response rate. Same CFPB site.

**Agent** (tools: confirm_number):

> Match - we get 99.43%, you said 99.46%. Essentially the same.
> 
> Timely response rate is now **provisional**. One more from a different angle to get to verified. Do you have the timely response rate for **Credit reporting** products during that same week?

## Turn 17

**User:** Yes - credit reporting for that week was 99.80% timely. That's from the same CFPB site.

**Agent** (tools: propose_checks, confirm_number):

> Match - we get 99.79%, you said 99.80%.
> 
> **Timely response rate is now verified.** On to the last one - relief rate. Do you have the relief rate for the whole business for the week of **7-13 November 2022**?

## Turn 18

**User:** That week was 1.44% relief rate. Same site.

**Agent** (tools: propose_checks, confirm_number):

> Very close but just outside the match threshold - we get 1.42%, you said 1.44%. The gap is only 0.02 percentage points, which could simply be rounding on the CFPB site.
> 
> Would you like me to accept this as a match (the difference is smaller than the rounding on a two-decimal display), or would you prefer to check one more angle first to build confidence?

## Turn 19

**User:** That difference is tiny - I'd call it a match. Let's move on.

**Agent** (tools: confirm_number):

> Confirmed. Relief rate is **provisional** - one more from a different angle to verify it. Do you have the relief rate for **Credit reporting** products during that same week of 7-13 November 2022?

## Turn 20

**User:** Credit reporting for that week was 0.06% relief rate. Same CFPB site.

**Agent** (tools: propose_checks, confirm_number):

> There's a technical snag - our number is 0.059% which rounds to 0.06%, so the values actually match, but the tool is struggling with such a small percentage. 
> 
> Could you give me the relief rate for a product where it's a bit higher - for instance, do you have the rate for **Mortgage** complaints during that same week? A bigger number will confirm more cleanly.

## Turn 21

**User:** I don't have Mortgage broken out for that week. I do have Florida for that same week - would that work instead?

**Agent** (tools: none):

> That works - what does your report show for the relief rate in **Florida** for the week of 7-13 November 2022?

## Turn 22

**User:** Florida for that week was 1.07%. That's from the same CFPB site.

**Agent** (tools: propose_checks, confirm_number, ToolSearch, analyze_seasonality):

> Here's what the analysis found, in plain terms:
> 
> **Weekday pattern - real and large for two metrics:**
> - **Complaint volume** swings by about 83% across the week. Sundays are by far the quietest (~370 complaints), weekdays peak around Wednesday (~1,070). That's expected - people file complaints during working hours.
> - **Relief rate** follows a similar weekday pattern, swinging about 29% - higher midweek, lower on weekends. This matters enough to account for.
> - **Timely response rate** does vary by weekday, but only by about 0.3 percentage points - too small to matter.
> 
> **Month of year and day of month** - both show real patterns in complaint volume and relief rate, but the data only covers 11-12 full cycles of each, so there aren't enough comparable earlier periods to use them reliably. They're noted but won't be applied.
> 
> **The recommendation:** account for the day of the week when comparing periods, and ignore everything else.
> 
> Does that sound right to you - should I apply the weekday adjustment?

## Turn 23

**User:** Yes, that sounds right. Go ahead and apply the weekday adjustment.

**Agent** (tools: save_pack, ToolSearch, run_checks, run_checks, run_checks):

> All three stay **verified** after the weekday adjustment - every stored number still matches.
> 
> A couple of things the automatic checks flagged that are worth knowing:
> 
> - **41,000 complaints have no state** - those will drop out of any analysis broken down by state.
> - **Sub-level categories are thin** - for sub-products, sub-issues, and individual issues, most have fewer than 30 complaints per week, so conclusions at that fine level won't be drawn. Top-level product is fine.
> - **The first few weeks of 2011** have very low counts - the data appears to have ramped up slowly at the start.
> 
> Now, one last step before you can ask questions: I need to check the analysis against a real past case. **Can you think of a time something went noticeably wrong - a week where, say, complaints spiked or timely response dropped - and you knew roughly why?** Which week was it, and what happened?

## Turn 24

**User:** Yes - the week of 4 September 2017. Complaints about Equifax shot up suddenly. That was the week the Equifax data breach was announced.

**Agent** (tools: ToolSearch, ToolSearch, add_incident, verify_expert):

> It found it. The analysis correctly identified Equifax as the driver of that spike in the week of 4 September 2017.
> 
> **The expert for complaint volume is now verified.**
> 
> ---
> 
> Here's where everything stands:
> 
> | Metric | Status | Expert |
> |---|---|---|
> | Complaint volume | Verified | Verified |
> | Timely response rate | Verified | Draft |
> | Relief rate | Verified | Draft |
> 
> The setup is complete and ready to use. You can now ask questions like "why did complaint volume rise in [some week]?" or "which companies are driving the timely response rate down?" and the analysis will run against the real data.
> 
> Do you have a question you'd like to start with?

## Turn 25

**User:** Why did complaint volume jump in the week of 4 September 2017?

**Agent** (tools: Skill, ToolSearch, get_intent, set_intent, run_intent):

> That read 24.5 GB - about 14 cents.
> 
> ---
> 
> **Complaint volume more than doubled that week: 9,379 complaints against a seasonally expected 4,596 (+4,783, or +104%).** The analysis is unambiguous about where it came from.
> 
> **What the data shows:**
> 
> - **When** (step `when`): The spike was concentrated on **Friday-Saturday 8-9 September** - those two days account for 110% of the full week's change. The rest of the week was broadly normal.
> 
> - **What product** (step `where`): 99% of the change falls in **Credit reporting**. Specifically the sub-product "Credit reporting, credit repair services > Credit reporting" explains 97% of that.
> 
> - **What issue** (step `where`): Within credit reporting, 85% of the change is the issue "Improper use of your report", and drilling further, 96% of that is the sub-issue **"Reporting company used your report improperly"** - a category that averaged 6 complaints per day in the prior four weeks and hit 4,288 on these two days.
> 
> - **Which company** (step `flat`, `refine`): **Equifax, Inc.** explains 94% of the overall change, and 95% within the credit reporting sub-product. They went from roughly 114 complaints per day in the baseline to 5,049 in the period.
> 
> - **How it was filed** (step `flat`, `refine`): 99% via the **Web** - consistent with a large number of consumers self-filing online in response to news.
> 
> - **Geography** (step `flat`): The change was spread evenly across all states - no single state dominates (the largest explains only 21%). This is consistent with a nationwide event.
> 
> **What the data does not show:** The data tells us exactly who was complained about, what for, and when - it is consistent with a major public event affecting Equifax customers nationwide. What caused it in the real world (the breach announcement, media covera
> ...
