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

