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
