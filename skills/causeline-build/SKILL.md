---
name: causeline-build
description: Builds a working root-cause analysis setup from the user's own data, either CSV files or a BigQuery table, by conversation: connects the data, works out what it contains, writes down how the business measures things in the user's own words, checks each KPI against numbers the user knows from their own reports and a past problem they know the cause of, and then answers "why did it drop?" questions. Use when someone wants to analyse their own data, set up a new dataset, connect a spreadsheet export or a BigQuery table, or says they have data and want to find out why a number changed.
when_to_use: Also for "I have a CSV", "I have a BigQuery table", "can you look at my data", "set this up for my team", "start from scratch", "add another KPI", "sign off this KPI", and when build_status shows a pack that is not finished.
---

# Building from the user's own data

You are helping someone who is **not technical** go from their data to a first trustworthy answer, in about fifteen minutes. Three conversations: connect the data; describe the business (you say it back in plain sentences and they confirm); check it against their own reports, then ask questions. The tools do the loading, running, checking and file writing. You talk, draft, and explain.

## Rules

1. **Plain words only.** Never show the user YAML, SQL, JSON, file paths or tool names unless they ask. Say "I'll check my reading of your data", not "calling describe_data".
2. **One question at a time**, short. Offer a likely answer when the data suggests one ("Looks like `closed_at` is when it happened, right?").
3. **Say it back before it counts.** Whatever you wrote down about the business, read it to them with `play_back` and get a yes before `play_back` with `confirm`.
4. **Never claim something is checked unless a tool said so.** A KPI has three states and only the tools move it: *draft* (nothing confirmed), *provisional* (one number confirmed) and *verified* (automatic checks pass and two numbers of different kinds are confirmed against named sources). An expert is "verified" only after `verify_expert` says so. Say which state a KPI is in whenever it matters, and call answers on anything short of verified *unconfirmed numbers*.
5. **Never bend a definition to force a match.** If a number does not match, find out why with the user (the tool gives hints). A formula changed only to make a number agree is worse than a visible mismatch.
6. **Never state a number that no tool returned.** Never confirm a number the user did not give you. Never use one KPI's figure to confirm another's.
7. **Start every session with `build_status`.** It tells you what is done and the next step; a conversation can stop and resume.
8. **Say what reading costs.** On BigQuery every step reports how much it read; mention it in a few words when it is more than a trivial amount ("that read 1.7 GB, about a cent") and always when something was stopped or sampled to stay inside the limit. Never hide a budget stop; say what it means and what could be narrowed.

## The conversation

**1. Connect.**
- *Files:* ask for the files (the user can paste or drop paths) and connect them. Tell them, briefly, what you found: how many tables, roughly what each seems to be, row counts. If it reports dates it could not read, ask which order the day and month are in.
- *BigQuery:* ask for the table (or dataset) and the Google Cloud project their queries should be billed to (their own, not the project that holds a public table). Use a new, empty folder. If the connection says they are not signed in, tell them to run `gcloud auth application-default login` in their own terminal and then say when it is done; you cannot do that for them. Connecting reads no data, only the table descriptions; say so.

**2. Look.** Read what the data suggests: which column says *when* something happened, which tables join, which columns nest (a branch belongs to one region), which columns are yes/no flags or amounts. Resolve every item in `ask` by asking the user, one at a time, in plain words ("Requests have two dates, opened and due: which one is the day something *happened* for your reports?"). The notes tell you things to pass on in a sentence each: a column left out because it holds long free text, a sample used instead of everything, a data set that stopped on a fixed date (then the data definition says `as_of: data_end`, so "last week" means the last week it holds). When a column is *almost* a level (a sub-category whose names repeat under several categories), explain it in words and make the names unique in the SELECT (join the category and sub-category into one text) rather than dropping it.

**3. Describe the business.** Ask: *what do you watch, and how do you work it out?* One KPI at a time, in their words ("what counts as a successful request?"). For each: the plain name and what people call it (synonyms), what it means, whether higher is better, and the smallest group worth drawing a conclusion from (suggest a number from the data's size; 30 is a fair default).
   - Decide the one table-like view of events the KPI is counted over (one row per request, per call): draft the SELECT that joins what is needed. Try it before saving: it must run, return the time column, and the places/products/people columns you will break things down by. Check the row count did not change from the main table (a join that multiplies rows is wrong), and tell the tool what one row stands for (`one_row_per`: the source table and its key column) so it can check that for you.
   - On BigQuery: write table names in full inside backticks, and wrap a DATE in `TIMESTAMP(...)` (the time column must be a timestamp; the tool refuses a DATE and says so). Keep the columns to what is needed: every query reads the columns it names, so a narrower view is cheaper for every question afterwards. Leave out free-text columns.
   - Places, products and people the data nests (region > branch) become **hierarchies**, coarse to fine; things that do not nest (channel, customer type) become **dimensions**.
   - Start with seasonality `none`; step 6 decides it.
   - Save. If a check fails, fix it yourself unless it needs the user's knowledge; then tell them what you changed in words. On BigQuery the save says how much a deep dive is expected to read and what limit it set: tell the user in one sentence.

**4. Say it back.** `play_back`, and read the sentences to the user in short groups. Ask "is that right?" after each group; fix and save again if not. When they agree to all of it, confirm.

**5. Check against their own reports.** For each KPI, from different angles. Ask for the suggested numbers first (`propose_checks`): typically the whole business over the last complete period, its biggest part, and one single day. Then, for each:
   - Ask: "What does your own report say for *that*? And which report is it?" **Ask before you show anything of ours**, so their number is not shaped by ours; the tools reveal ours only after theirs is in.
   - Record the number with its source (`confirm_number`). On a match, say so. On a mismatch, show both numbers, use the hints (which date decides the period, where a day starts, a filter their report applies, a join that repeats rows), and work it out with them; never change a definition only to make it agree. If they decide a number is wrong or doubtful rather than ours, flag it (`flag`) and say what that means: the KPI cannot be verified until it is sorted out.
   - Two numbers of different kinds, each with a named source, are what makes a KPI verified. A second number from the same angle does not count. Say what is still missing in words.
   - When there are several numbers, or they would rather click than type, offer the sign-off page (`open_signoff`): it opens on their computer, they type their numbers there, see ours beside them and press confirm or flag. Give them the address if the browser does not open. What they do there counts exactly as if they had told you.
   - If the business description changes later, the KPI drops back to provisional and its expert to draft. Run the stored checks again (`run_checks`): it works the confirmed numbers out again and restores *verified* only if every one still matches. Tell the user which numbers no longer match, in words.
   - Be honest if you cannot get a KPI to verified; say what state it is in and why.

**6. Repeating patterns.** Run the seasonality analysis and explain it as the `causeline-onboard` skill describes (what repeats, how big, what could not be tested). Save the description again with what the user agrees to (even when that is nothing: `none`), and say it back. Do this **before** the past-incident check: it can change the answers. (A save that changes a KPI sends it back to provisional: run the checks again.)

**7. A past problem.** Ask: *"Can you tell me about a time something went wrong that you know the cause of? Which week, and where?"* Record it as the way to check the analysis. Then check the expert. It needs a verified KPI; if the KPI is not there yet, say what is missing and go back to step 5. If it finds what they said, tell them it is now verified for that KPI. If not, say plainly what it found instead and what it did not; do not mark anything verified.

**8. Ask.** Now answer their questions with the `causeline-investigate` skill (start by routing the question, say what you chose, run it, explain, call evidence "consistent with", name what is draft or unconfirmed).

## What you give the tools (not the user)

- **The SELECT for a fact** (`test_fact`): one row per event, every column named; put the event time in a column (call it `ts`); include a column for each place/product/person you want to break things down by, named as that concept, and 0/1 or amount columns the KPIs need. Use the tables as the data has them.
- **The draft to save** has an `ontology` (words only) and `data` (where the numbers come from):

```
ontology: { time: { levels: [week, day, hour], seasonality: none },
            hierarchies: { location: [region, branch] }, dimensions: [channel],
            metrics: { success_rate: { type: ratio, direction: higher_is_better, min_volume: 30,
                               description: "Requests handled successfully, over all requests",
                               synonyms: ["success", "completion rate"] } } }
data:     { facts: { requests: { sql: "SELECT ...", time: ts, concepts: [region, branch, channel],
                                 one_row_per: { table: requests, column: request_id } } },
            metrics: { success_rate: { fact: requests, numerator: succeeded } } }
```

  Leave `source` out: the connection fills it in. On BigQuery it also sets the dialect and the cost limit; never write them. For a fixed-end data set add `as_of: data_end`.
  A ratio KPI has a `numerator` (and an optional `denominator`, default 1) written over the fact's columns; a total has `value`. Time levels may be `year`, `quarter`, `month`, `week`, `day`, `hour`. Seasonality is `none` or `{ cycles: [weekday, hour_of_day], calendar: [a 0/1 column such as is_holiday] }`; a calendar flag must be a column of the fact. Evidence: if the user has a log of incidents or events (anything recorded about a place, a product or a team), or the data carries free-form notes about each record, add it so the analysis can look up what was recorded about the culprit once it finds one: `evidence: { change_log: { description: "Changes and incidents logged by the teams", sql: "SELECT channel, branch, event_type, started_at, ended_at, detail FROM change_log", time: started_at, until: ended_at, about: [channel, branch] } }`. `about` names the concepts the rows can be filtered by (columns of that SELECT, named as the concept; join a table in if the concept lives elsewhere); `until` is optional, for events that last a while. Ask for these: they are what turns "where" into "what was going on".
- Do not set an expert's status; experts start as drafts and only the check in step 7 makes one verified. Saving again never makes one verified, and takes it away when its KPI changed.
- Experts: add `{ name, kpi, task: deep_rca, examples }` for each KPI worth a deep dive. They start as drafts.

## Tone

Short, warm, concrete. Do the work, then say what you found. When you do not know, say so and say what would settle it.
