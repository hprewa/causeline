# Phase 1 close-out: evidence

What this block set out to do (sign-in without a terminal, an engineer install path, Codex run for real, a tester kit) and what each step showed. Anything not shown is listed under the step.

## Step 1: the engineer path (`causeline init`)

**What it is.** From a checkout: `npm install`, then `npm run init -- --client codex|claude-code|desktop` (or `node bin/causeline.mjs init ...`). With no client named it sets up whichever of Claude Code and Codex it finds. It builds if nothing is built, assembles the server, puts a **stable copy** of the server and the core playbooks in the Causeline home (`engineer/`), then:
- **Codex:** runs the existing installer against that copy, so Codex's settings point at the copy and not at the checkout (which may be a cache). The installer backs up what it changes; running it twice changes nothing.
- **Claude Code:** writes a small marketplace beside the copy and uses Claude Code's own `plugin marketplace add` and `plugin install` commands (found in its help, not assumed); if `claude` is not on the path it prints the two commands.
- **Claude Desktop:** builds the `.mcpb` and opens it.
It ends with the readiness check unless `--no-check`.

**Shown.** `node scripts/init-proof.mjs` in a temporary home (Codex home and Claude config both redirected): init with no client; Codex set up, the server entry and playbooks path written, the four skills added, a second run leaves the settings byte-identical; the server copy is under the Causeline home; Claude Code's plugin is listed as installed and enabled by the real `claude` CLI; `claude plugin validate` on the marketplace passes. A fresh clone with `npm install` then `init --client codex` worked end to end (about a minute after the install).

**What did not work, and why.** The plan said `npx github:hprewa/causeline init`. It does not work: npm builds a git dependency by running its `prepare` script, and for a workspace repository the build fails inside npm's temporary clone with no useful message (reproduced on npm 10.5, Windows). So the path is clone, `npm install`, `init`; the `npx github:` form is not offered. Nothing was published to npm.

**A latent build fault found on the way and fixed.** A clean checkout could not be built: the Builder uses the eval package, which used connect-bigquery, which builds on the Builder, so no order of building works until some output already exists (it never showed because built output was always there). The eval package now loads cost control when a run needs it (a runtime import with a local type), which breaks the cycle at build time; the bundler still includes it. A fresh clone now builds in the listed order. The release workflow's `npm ci && npm run build` would have hit this on a clean runner.

**Checks after the change.** Unit tests pass in every package (46, 31, 173, 27, 22, 12, 38, 63, 21, 60 with 8 skipped); purity passes; integration 8/8 (run from PowerShell; the Bash tool's shell here makes one integration subtest crash with a Windows job-object error, which is the environment and not the code: the same subtest passes from PowerShell).

**Not shown.** macOS and Linux; Claude Desktop's `.mcpb` opening on a real Desktop; a person doing this; the Codex app reading what init wrote (step 3 runs Codex).

## Step 2: signing in without a terminal

**What it is.** A `sign_in` tool. An administrator makes a "desktop app" sign-in file once in their own Google Cloud project (no Google review involved); the person gives its path to the assistant once, which keeps a copy in the Causeline folder (`google/`). Signing in then starts a listener on `127.0.0.1` only, opens Google's own page (authorization-code flow with PKCE, scope `bigquery` only, a random `state`), exchanges the code for a lasting sign-in, and keeps it in the same shape Google's tools write (`authorized_user`). The server sets `GOOGLE_APPLICATION_CREDENTIALS` to it when the person has not pointed Google's libraries elsewhere, and restarts the data connection software so both it and the Node client use it. The person's own `gcloud` sign-in is never touched. `check_connection` now says which sign-in is in use and what the last attempt did, and for "not signed in" or "expired" points at `sign_in` (or, with no file yet, at the administrator).

**Shown (against a fake Google).** 9 tests in `core/connect-bigquery/test/signin.test.ts` and 4 in `core/mcp-server/test/sign-in.test.ts`: the link asks for a code with PKCE, comes back to the local address only, asks for BigQuery only; a right-state answer is exchanged with a verifier that matches the challenge and the sign-in is kept in the expected shape; a wrong state, a refusal, a missing lasting sign-in, a refused code and a timeout each say so in words and keep nothing; a web-app file or an unreadable file is refused with what to ask for; the tool returns at once with a link and says the assistant never sees the password; Causeline's own sign-in is used only when the environment does not point elsewhere. The administrator's console steps are in `docs/guides/analyst-sign-in.md` (Internal consent screen for Workspace organisations; Testing mode with test users otherwise, with Google's 7-day and 100-user limits stated).

**Not shown.** A sign-in against real Google (pending the Desktop client in the test project); Google's own consent screens and their wording; a token that expires or is revoked after a successful sign-in (the refresh path is Google's library, the message wording for it is the existing "expired" one); a machine with no default browser (the link is given for that case).
