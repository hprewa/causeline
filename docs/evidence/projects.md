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
- Not yet: the drift check on opening, the localhost pages, the skill text that teaches the project flow, the plugin and extension settings.
