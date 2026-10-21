# Projects and the local companion page

Aim: whatever the person builds is saved in a **project** they can open by name from any client (Claude Code, Claude Desktop, Codex), in a later session, without choosing a folder or setting an environment variable. Steps are listed in `PROGRESS.md`.

## Step 1: the project registry and the tools to use it

**What was built**
- `core/builder/src/projects.ts`: a home folder (`CAUSELINE_HOME`, else a `Causeline` folder in the person's home) holding `projects.json`, a registry from a name to a folder. Create (a folder named from the name, a name used once), register an existing folder, find by name (case does not matter, a unique start is enough, an unclear name is never guessed), open (notes when), the project opened last, and a summary of a project from its files only (KPIs and rung, experts, tables, incidents, recent changes of rung, next step).
- The MCP server finds its project instead of only being pointed at one: `CAUSELINE_PACK` if set; else the client's project folder or the working folder if it already holds a project; else the project opened last; else the client's project folder (a fresh build there, as before); else none, and every tool says "no project is open" and what to do.
- Tools `list_projects`, `create_project`, `open_project`, `project_summary`. Creating or opening a project changes what every other tool works on: the server's folder, where results go, the data connection started for the old one (Toolbox restarts on its next use), and the question being built (cleared). Tool results carry names, never folder paths.

**Evidence**
- 6 tests of the registry (names, folders, collisions, unique start, vanished folder, registered folder, an empty project's summary) and an end-to-end test over stdio: no project open says so; create and open switch the open project; no path reaches the model; a name is used once; a new session in the same home opens the project opened last.
- All unit tests pass in every package. While doing this I found that two tests of the build skill had been failing since the ladder edit (the skill had lost its mention of `verify_expert`, and a test still expected the old wording); both fixed. I had not re-run the unit tests after that edit.

**Not shown**
- The evals and the scripted end-to-end tests were not re-run after this step (the change is to how the server finds its project; the existing tests set `CAUSELINE_PACK`).

## Step 2: the drift check on opening a project

**Question:** when someone opens a project days later, can they trust the numbers they confirmed then, and if the data has moved, is it said before any answer is given?

**What was built**
- `driftCheck` (`core/builder/src/checks.ts`): works the confirmed numbers out again (not the automatic checks, whose stored result is kept) and compares them with what the person gave. A number that no longer matches goes back to pending with the new figure; its KPI drops a rung (the expert follows), and the status log says "opening the project". If the numbers cannot be worked out at all (no connection, an expired sign-in) nothing is lowered and the result says it could not check. The outcome is stored (`drift` in the build state) and shown in the project summary.
- `open_project` runs it when the project has confirmed numbers and puts the outcome first in its result (`drift`: ok, a sentence, which KPIs fell). `runChecks` gained a quick mode for it.

**Evidence**
- A test over a real workspace: all stored numbers match, so nothing changes and the sentence says "all 3 stored numbers still match"; then one stored number is changed to simulate the data moving: the check reports it, the KPI falls from reconciled to draft, the expert follows, the log names the step; then a check whose tools fail changes nothing and says it could not check.
- All unit tests pass in every package.

**Not shown**
- On BigQuery each stored number is a query: the cost of opening a project with many confirmed numbers was not measured (the per-question budget still applies).
- It was not run through the MCP server over stdio against a real data connection, only at the Builder level and through the typed service.
- The skill text that tells the model to say the drift outcome first is not written yet (step 4).

## Step 3: one local site with read-only pages next to the sign-off screen

**Question:** can a person see where the project stands, how the analysis decides, and the facts behind each answer, from one link, without anything on those pages able to change anything?

**What was built**
- The local server that serves the sign-off screen (same secret in the address, same machine-only checks) now also serves, under the same address: **Overview** (`home`: the KPIs and how far each is trusted, the experts and what each can honestly say, the data, the drift check, recent changes of rung), **How it decides** (`playbooks`: each playbook as steps in plain words, the condition on a step, what it records, and the rules that choose what follows), and **Results** (every kept answer newest first, and one page per answer: headline, where it changed, who contributed how much against their usual, the KPIs it handed over to, patterns that can hide a problem, supporting records, how each step went, cost). The sign-off page keeps its address and gains the same menu.
- The new pages are built on the server with every value escaped, carry **no script, no form, no button and no input**, and their policy allows none. The only page that takes input is the sign-off page. A result is read only by a plain file name that is inside the project's results folder.
- A tool `open_project_page` opens the overview and returns the link; `open_signoff` is unchanged.
- A project that was not built here (a shipped example pack) shows its experts' rungs as written and says its checks are not tracked, instead of showing draft KPIs under reconciled experts (found by looking at the picture).

**Evidence**
- 7 tests over HTTP: the overview shows KPIs, rung and the plain sentence, and refuses a missing secret or another site as origin; every read-only page has no script, form, button or input, a policy with no script, and nothing from elsewhere; the sign-off page carries the menu and the menu reaches every page; how it decides shows the plain labels, the `when` condition and the facts; results are listed newest first, opened by name, and a hostile value (`<script>alert(1)</script>`) is shown as text; six path tricks (`..%2F`, backslashes, encoded dots, a name not in the folder, a slash) all say "cannot be shown" and never return the file outside the folder; escaping covers the five characters.
- **Looked at, in a real browser, light and dark** (headless Edge, over the complaints pack and its saved results): `docs/evidence/projects/` holds the overview (light and dark), how the steps decide, one result, and the list of results. Looking found three things, all fixed: the overview of a shipped pack said "connect the user's files" and showed KPIs as draft under reconciled experts; the data line said "none connected"; the list of "patterns that can hide a problem" was dominated by "groups too small to judge" notes, now folded away; and the results list now says which period each answer was about.
- All unit tests pass in every package.

**Not shown**
- The pages were not opened through the real MCP server by a live assistant: the pictures are of the pages served by the same code over a pack on disk.
- The sign-off page itself (with its buttons) was not re-shot after getting the menu; its own tests pass.
- Nothing teaches the model to offer these pages yet (step 4: the skills).
- Long result lists show only the latest 40.

