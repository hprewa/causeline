# The analyst install path

Aim: an analyst who is not a coder gets from a download to a first answer on Claude Desktop, Codex or Claude Code without a terminal, Node, YAML or a manual download of the data connection software. Plan and the spike findings it rests on: `docs/evidence/phase-1-spikes.md`. Steps are in `PROGRESS.md`.

## Step 1: the data connection software is fetched the first time it is needed

**What was built** (`core/runner/src/toolbox-install.ts`)
- A pinned table of the four builds that exist for Toolbox 1.14.0 (Windows x64, macOS arm64, macOS x64, Linux x64) with their size and **SHA-256**. There is no Linux arm64 build; a machine with none gets a plain message naming the manual route. The fingerprints were computed by streaming each download once from Google's bucket (the Windows one equals the hash of the file already on this machine); Google publishes none.
- `ToolboxInstaller`: downloads to a `.part` file, resumes with a Range request, checks size and fingerprint, makes the file executable on macOS and Linux, then moves it into `<Causeline home>/bin/toolbox-1.14.0/`. A file that does not check out is deleted and never run. **Nothing waits for it**: `ensure()` returns the path when it is there, otherwise starts one download and returns what to tell the person ("I am preparing the data connection for the first time (about 294 MB, 35% done). This takes a few minutes; ask again shortly."). A second process sees the first one's progress note and does not fetch again; a stale note does not block. A failed try is tried again on the next use.
- `findToolboxBinary` now looks, in order: the explicit path, `CAUSELINE_TOOLBOX`, PATH, the fetched copy in the Causeline home, the repo root. `causelineHome` is shared with the projects code (one definition of where the home is).

**Evidence**
- 9 tests against a local download server (so no 300 MB transfer): a first use returns at once and says so, the download completes, the file is there and checked, the next use is immediate, no `.part` is left; a wrong fingerprint and a wrong size are each deleted, never used, and retried; a download stopped half way resumes with `Range: bytes=60000-`, and a leftover longer than the file starts again; offline, a 403 and a folder that cannot be made each say what to do; an unsupported machine never tries; a second process does not fetch again and a stale note is ignored; two uses in one process share one download; the lookup order; the table has four builds, each with a size and a 64-character fingerprint.
- All unit tests pass in every package; the purity guard passes.

**Not shown**
- The other three platforms' fingerprints were computed but those files were never run: no macOS or Linux machine was available.
- A company proxy that Node's `fetch` does not use (it does not read `HTTPS_PROXY`) will fail the download; the message sends the person to the manual route. This was not tested.

## Step 2: wired into the server, with a plain-words readiness check

**What was built**
- `ToolboxManager` (the one place the server starts the data connection) now looks for the program as before and, if there is none, starts the download and answers the tool call with the plain-words message instead of an error about a missing file. A machine with no build says so. Tests can replace how the program is looked for.
- A `check_setup` tool (`core/mcp-server/src/setup-check.ts`): one plain line each for the version, the Causeline folder (can be written to), the data connection software (ready, or how far along the download is; the first check starts the download), the sign-in when the open project is on a cloud database (the existing connection check), and the open project; each with what to do when it is not ready. It never puts a folder path in a line. The tool is marked read-only: its only side effect is the cache of the software it fetches.
- `scripts/install-proof.mjs`: a clean-machine run that can be done here.

**Evidence**
- 4 tests in the server package: the first use with nothing on the machine starts the download and says so; a machine with no build says so; a machine where the program is already present does not fetch; the check's lines, its refusal to show a path, an unwritable folder, a running Toolbox counting as ready, and the sign-in line.
- **A clean-machine run, for real.** The bundled server was copied to a place with nothing of the repository around it, given a new Causeline home, a PATH holding only Node and the system folder (checked: no Toolbox on it), and no Toolbox variable. A question that needs the data connection was answered at once with "I am preparing the data connection for the first time (about 294 MB, 0% done)..." (0.4 s). `check_setup` then showed progress from 0% to 94% every five seconds, and the software was **ready after 76 seconds**; the fetched file was there, its SHA-256 equalled the pinned one, and no `.part` or progress file was left. The same question was then answered by the analysis (the planted fault, `team_05`, first), 90 seconds from the start.
- All unit tests pass in every package; purity passes.

**Not shown**
- One download on one connection (about 4 MB a second here); a slow connection is slower and the person is told to wait, which was not timed. The first question that does not need the data connection (the list of playbooks) answers at once, as intended.
- Not run through Claude Desktop, Codex or a live assistant; the plugin's bundle is what ran. The `.mcpb` and the executable are the next steps.

## Step 3: the guidance reaches every client through the server

**Why:** in Claude Code the guidance (when to build, how to investigate, how to explore, what never to do) is a skill. A Claude Desktop extension and a Codex server cannot carry skills, so on those the assistant would have had the tools and none of the rules for using them.

**What was built**
- `get_guide` (a tool) and four resources (`causeline://guide/build`, `investigate`, `explore`, `onboard`): the skills' own text, without the front matter, with when each applies. With no name the tool lists them. The text is embedded in the bundled server file at build time, so the one file serves the guides with nothing beside it; run from the source it reads the skills folder. **One source: `skills/*/SKILL.md`.**
- The server's handshake instructions are rewritten to be client-neutral: before acting on a request call `get_guide` with the name that fits (what each name is for, in a sentence); where the client has the skill, follow the skill; at the start on a new computer or when something does not connect call `check_setup`; the rules that hold in every case (plain words, no YAML, SQL or paths, never write pack files, read the data only through the tools, no number a tool did not return, nothing called checked unless a tool said so, say how far the numbers are trusted, an explore answer is exploratory); projects (`list_projects`, `open_project`, `create_project`, never ask for a folder).

**Evidence**
- 4 tests: every guide equals its skill's body (so they cannot drift), has its text and a when-to-use; the tool lists, returns one, and refuses an unknown name naming the real ones; front matter parsing; over stdio the server's instructions carry the five points above, the tool and the four resources are listed, and the tool and a resource return the skills' text.
- **The bundled server file copied alone** into an empty folder (no skills folder, no playbooks) served all four guides, each equal to its skill, and four resources.
- All unit tests pass in every package; the scripted end-to-end tests pass.

**Not shown**
- Whether Claude Desktop or Codex assistants actually call `get_guide` first when told to by the instructions. Nothing here has run either client; a model can ignore instructions, as the Explorer runs showed. The instructions also state the rules that matter most, so a model that skips the guide still sees them.
- The guides are long (the build guide is the longest): their size in an assistant's context was not measured.

## Step 4: one file for Claude Desktop

**What was built**
- `clients/claude-desktop/manifest.json` and `scripts/bundle-desktop.mjs` (`npm run bundle:desktop`): `dist/causeline-<version>.mcpb`, **0.8 MB**: the one bundled server file (guides inside it), the core playbooks, a placeholder icon the build draws itself, and the manifest. No Toolbox. Manifest version 0.3 (the current one in the spec I read on 22 October; the page also mentions 0.4 for another runtime): server type node, command `node` with `${__dirname}` (never `npx`), the settings screen asks for **a folder** (default `${HOME}/Causeline`, the same place the server uses when it is told nothing) and an **optional BigQuery project**; no credential is asked for (sign-in is Google's own); macOS and Windows; Node 20 or later (Claude Desktop ships its own).
- Built and checked with Anthropic's own tool (`@anthropic-ai/mcpb` 2.1.2): `validate` ("Manifest schema validation passes!") and `pack`.

**Evidence**
- 3 tests of the manifest (starts with Node from inside the extension, no `npx`, a folder with a sensible default, an optional string whose empty default still fills the variable, nothing secret, the platforms, every tool it lists exists in the server).
- **The extension, run as Claude Desktop would** (`scripts/desktop-proof.mjs`): the `.mcpb` was unpacked with the same tool, its manifest read, the variables filled in as the settings screen would (a folder of the person's choosing, no BigQuery project), and the server started with exactly the command, arguments and environment the manifest gives, and a PATH holding only Node (no Toolbox on it, checked). Through the MCP protocol, **20 checks passed**: all nine listed tools are offered; the instructions tell the assistant to ask for the guide and a guide is served from inside the extension; a project registered in the chosen folder is listed by name and no folder path reaches the assistant; a new project is made and kept in the folder chosen in the settings; the first check says the data connection software is being prepared (0%), a question asked during the fetch is answered in plain words and not with an error about a missing file; the fetched software ends up in the chosen folder and matches its pinned fingerprint; the analysis then runs on the example project (the planted fault first); an exploratory read works and is labelled. 91 seconds from start to finish, including the real 294 MB fetch.
- All unit tests pass in every package; purity passes.

**Not shown**
- **Claude Desktop itself has not installed or run this file.** Everything above is the manifest's instructions followed by hand, with Claude Desktop's own Node assumed to be Node 20 or later (this machine's is 20.12). How Desktop displays the settings screen, whether it asks permission for each tool, how it treats a tool that answers "ask again shortly", and whether it passes the variables exactly as the spec says are not known.
- macOS was not run. The placeholder icon is plain; it needs a real one.
- The extension is not signed and not in any directory (the directory no longer takes submissions: people install the file).

