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
- Nothing here has downloaded the real 294 MB file through the installer yet (step 2 does, through the server). The other three platforms' fingerprints were computed but those files were never run: no macOS or Linux machine was available.
- A company proxy that Node's `fetch` does not use (it does not read `HTTPS_PROXY`) will fail the download; the message sends the person to the manual route. This was not tested.
- The installer is not wired into the server's tools yet (step 2).
