# Trying Causeline: a one-hour test for someone who is not an engineer

Thank you for trying this. You are testing the software, not yourself: if something confuses you, that is the finding. Please say what you are thinking out loud (or write it down) as you go, and **do not ask for help unless you are completely stuck for five minutes**; note the time you got stuck instead.

You need: a computer, one of the assistants below, a Google account that can read some BigQuery data (or use the public example in part 3), and about an hour. Nothing you do here changes any of your data: Causeline only reads.

Keep a clock running. Write down the time at the start of each part.

## Part 1: get it running (target: 15 minutes)

Pick the assistant you already use and follow `docs/guides/analyst-install.md` for it (Claude Desktop, Codex, or Claude Code). Then say to the assistant: **"Check that Causeline is ready."**

Note: how long it took, where you hesitated, anything you had to guess.

## Part 2: sign in to Google (target: 10 minutes)

Say: **"Sign me in to Google."** If the assistant asks for a sign-in file, that is the file your administrator makes (`docs/guides/analyst-sign-in.md`, "For an administrator"); the person who gave you this kit will have it. A Google page opens: choose your account and allow access. Then tell the assistant you are done.

If it says you do not have access to some data, ask: **"Write the message to my administrator."** You do not need to send it for this test.

Note: whether you were ever unsure what was happening, and whether anything looked unsafe or asked for something you did not want to give. You should never be asked to type a password into the chat.

## Part 3: describe one KPI (target: 20 minutes)

Say: **"I want to set up Causeline for the number I care about."** Then answer its questions in your own words. Use a metric you really watch on data you can read. If you have none, use the public example: *complaints received per week*, in the dataset `bigquery-public-data.cfpb_complaints`, with `yukti-dev` (or your own project) paying for the queries.

Things to notice: Did it ask one thing at a time? Did it tell you what a look at the data would cost before doing it? Did you know what to answer when it asked about tables, dates or past incidents? If it stated a number, did you know where it came from?

## Part 4: ask why something changed (target: 10 minutes)

Say: **"Why did my number change last week?"** (or pick a week that you know moved). Read the answer.

Note: Did you understand it? Did it tell you what is certain and what is only "consistent with"? Would you trust it, and why or why not? What is missing?

## At the end

Fill in `docs/guides/tester-feedback.md` (one page), and send it back with your notes. A transcript of the conversation is the most useful single thing you can send.
