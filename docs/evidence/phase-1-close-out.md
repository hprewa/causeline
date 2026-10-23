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

**Real Google, shown.** `node scripts/signin-proof.mjs --client <file>` (one run, one account, a desktop-app client made in the test project, the person clicking through Google's page once): with Google's own tool sign-in hidden (an empty Google config folder, no credentials variable) the connection was refused as not signed in; with no sign-in file the tool asked for one; with the file a sign-in started and returned at once with a link; after the click Causeline held its own sign-in (`authorized_user` shape, values not shown, in its own folder) and `check_connection` said it was in use; the public complaints dataset connected with it alone; discovery shortlisted `complaint_database` and, after a go-ahead, read it and drafted sentences; the person's own Google tool credentials file was not modified (same timestamp before and after). The temporary folder was deleted. The access can be removed at myaccount.google.com/permissions.

**Not shown.** The Toolbox process using the sign-in (discovery goes through the Node client; the server sets the variable and restarts Toolbox, which is covered by design and by the unit tests but was not run against Google); an account on another organisation or consent-screen type (this was one account); a sign-in that expires or is revoked later; Google's consent wording; Google's own consent screens and their wording; a token that expires or is revoked after a successful sign-in (the refresh path is Google's library, the message wording for it is the existing "expired" one); a machine with no default browser (the link is given for that case).

## Step 3: Codex, run for real

**What was built.** `runCodex` and `parseCodexStream` in `core/eval/src/agent.ts` turn `codex exec --json` events into the same evidence the Claude Code runs give (tool calls with their answers, the last message, the thread to resume); `scripts/codex-home.mjs` makes a throw-away Codex home (the person's sign-in copied in, Causeline installed through `causeline init`, their own Codex settings untouched; the copy holds a token and is deleted after a run); `build-conversation.mjs --client codex` and `eval --agent codex --codex-home <dir>` use them. 2 tests on recorded events.

**Findings about Codex itself (version 0.164.0, Windows).**
- The person's global Codex settings named a model the ChatGPT account cannot use (`gpt-5-codex`); the harness picks one from `codex debug models` (`gpt-5.6-terra`).
- Non-interactive Codex refuses any MCP tool that writes ("MCP tool call requires approval, but approval policy is never"). The harness sets `mcp_servers.causeline.default_tools_approval_mode="approve"`. In interactive Codex the person sees an approval prompt for such tools; the Codex guide says so. Nothing in the installer turns approvals off.
- A saved Codex login had gone stale (token refresh 401) until `codex login` was run again.

**Shown.** Causeline's tools run inside Codex: the first real use (list projects, create a project) works. Two guided-setup conversations with the simulated shop analyst, one run each, no rates:
1. With Google's stored sign-in expired (`invalid_rapt`), Codex asked the prep-card questions one at a time, including the past-incident question after the person had no report numbers, said the sign-in had expired and gave the terminal command, retried twice, passed the policy error on, called `sign_in`, explained that a desktop-app sign-in file was needed and holds no password, offered a CSV export as an alternative, and ended with the definition saved, the KPI a draft and "0 of 2 build steps". It stated nothing it could not back up.
2. After `gcloud auth application-default login`: the card, a connection to the seven-table shop dataset, the cost limit offered and set to about $1, `discover_for_kpi` (orders and order items, orders confirmed), a saved draft definition played back and confirmed, a seasonality check (nothing worth adjusting) and a data check with two cautions (64 days with no orders, 413 thin days). 11 turns; it ended before sign-off numbers.

**Not shown.**
- **Agent-level question evals through Codex: none scored.** All six contact-centre cases (runner level 6/6) failed at the agent step with the account's usage limit ("You've hit your usage limit ... try again at Nov 22nd"), a free-allowance limit reached after the two conversations. Those are errors, not failures, and there is no pass rate for Codex.
- The complaints cases on BigQuery through Codex; the Codex desktop app; interactive approval prompts; macOS/Linux; any rate (one run each).
- The Claude Code setup conversation was not re-run to check the `9afa2dc` fixes (the Codex run showed the incident question asked; that is a different assistant).

## Step 4: regression after the whole block

Run from PowerShell on the final code (one run each; the Bash tool's shell crashes one integration subtest on a Windows job-object error, so these are not run from it):
- Build and unit tests: exit 0, no failures (mcp-server 64 tests, 56 run and 8 that need the integration switch).
- `check:purity` and `check:ladder`: pass.
- Contact-centre eval at runner level: **25/25**, all four `metric_change` branches taken. Routing: **38/38**. Intents: **16/16**. Integration: **8/8**.
- Complaints eval on real BigQuery (`yukti-dev`): **7/7**, three of three applicable `metric_change` branches taken.
- `bundle:plugin`; the Claude Desktop extension run (**passed**, including the first-run fetch of the data connection software); the single-executable run (**passed**); the engineer-path proof (`causeline init` for Codex and Claude Code in a temporary home, second run changes nothing; **passed**).

**Not shown:** these are runner-level evals plus the install proofs; the live-assistant evals were not re-run this block except the two Codex setup conversations (one run each) and no Claude Code assistant run after the final code; nothing on macOS or Linux; no real analyst yet (the tester kit is written, the trial is not done).
