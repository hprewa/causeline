# Testing Causeline in Codex: what was done, so it can be repeated or pushed harder

Written after the first Codex runs (Phase 1 close-out, step 3). Codex 0.164.0 on Windows, signed in with a ChatGPT account on the free allowance. Results and what is not shown are in `phase-1-close-out.md`; this file is the how.

## What you need
- The Codex CLI: `npm i -g @openai/codex`, then `codex login` (a stale login fails every call with `401 ... could not be refreshed`; log in again).
- Run test commands from **PowerShell**. From the Bash tool a Windows job-object error (`AssignProcessToJobObject: (87)`) kills runs that start the data connection software.
- For BigQuery runs: `gcloud auth application-default login` fresh (an expired one fails with `invalid_rapt`), and `CAUSELINE_BQ_PROJECT=yukti-dev`.
- A model the account can use. List them with `codex debug models` (entries marked `list`); the person's own settings may name one the account cannot use (`gpt-5-codex` did not work). The harness defaults to `gpt-5.6-terra`.
- Usage: a ChatGPT login has an allowance and no per-call price; the harness prints "$0.00" for Codex, which is not the real cost. Two setup conversations (about 25 assistant turns) used up the free allowance (reset date was shown in the error). Plan on a paid plan or a reset before an aggressive run.

## The pieces
- `node scripts/codex-home.mjs [--causeline-home <dir>]` makes a throw-away Codex home: copies `auth.json` (a token: delete the folder afterwards), runs `causeline init --client codex` into it, prints both folders as JSON. The person's own `~/.codex` is never touched.
- `node scripts/build-conversation.mjs --client codex --persona <file> [--opening "..."] [--turns N] [--codex-model <m>]` plays a simulated user (a tool-less Claude call) against Codex. Personas: `packs/complaints/evals/setup-persona.md` (complaints) and `setup-persona-shop.md` (shop orders, `bigquery-public-data.thelook_ecommerce`). Transcripts go to `runs/`.
- `node core/cli/dist/src/main.js eval --pack <pack> --agent codex --codex-home <dir> [--case a,b] [--codex-model <m>]` asks each eval case's question to Codex and scores it as for Claude Code.
- `runCodex` / `parseCodexStream` (`core/eval/src/agent.ts`) read `codex exec --json` events: `thread.started` (the thread to resume), `item.completed` with `agent_message` (the answer) or `mcp_tool_call` (tool, arguments, result or error), `turn.completed` (tokens), `turn.failed` (the reason).

## Things Codex needed that Claude Code did not
- `-c 'mcp_servers.causeline.default_tools_approval_mode="approve"'`: non-interactive Codex refuses any MCP tool that writes ("requires approval, but approval policy is never"). Test harness only; the installer does not set it.
- Server environment goes in through `-c 'mcp_servers.causeline.env.KEY="value"'` (Codex passes a server only what its config lists): `CAUSELINE_HOME`, `CAUSELINE_PACK` (eval cases), `CAUSELINE_TOOLBOX`, `CAUSELINE_BQ_PROJECT`, `CAUSELINE_NO_BROWSER=1`.
- `-s read-only` for the first turn; a resumed thread (`codex exec resume <id> ...`) is given no sandbox flag.
- The simulated user must not be given the Codex model name: the first attempt passed it to the Claude call and the "user" replied with an error message (fixed: `--codex-model` is separate).

## Steps taken, in order
1. Installed the CLI; `codex login status` said logged in, but a call showed the 401 token refresh failure; the person ran `codex login`.
2. First call failed on the unusable model in the person's settings; chose a listed model.
3. Installed Causeline into an isolated home with `causeline init --client codex` and asked Codex to list projects: `get_guide`, `list_projects` ran.
4. Asked it to create a project: refused for approval; found the approval setting above.
5. Wrote the stream parser and runner, with 2 tests on recorded events.
6. Setup conversation 1 (shop persona, Google sign-in expired): 14 turns; reached the expired-sign-in dead end and used `sign_in` correctly.
7. The person re-signed in to `gcloud`; the scripted setup proof passed again; setup conversation 2: 11 turns, through discovery, the saved definition, the seasonality check and the data check.
8. Six contact-centre eval cases through Codex (`understaffed_team, clean_week, offset_sibling_teams, pure_mix_rerouted_queue, missing_logs_site, call_surge_billing`): started from Bash (job-object crash), restarted from PowerShell; runner level 6/6; all six agent runs failed on the usage limit.
9. Deleted the throw-away Codex homes (they held a copy of the sign-in token).

## To push harder when the allowance is there
- The six cases above, then the rest of `packs/contact-centre/evals/cases.yaml` (25), `intents` (`--intents --agent codex` is not wired for Codex yet; only the case evals are), and the complaints cases on BigQuery (`packs/complaints`, needs a fresh `gcloud` sign-in).
- Repeat each case several times: one run is not a rate.
- Run the Claude Code setup conversation again to see whether the incident-question and per-day-figure fixes (`9afa2dc`) hold; Codex asked the incident question without being nudged.
- Interactive Codex (approval prompts) and the Codex desktop app have not been tried.
