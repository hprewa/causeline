# Access spikes: sign-in, a no-install path on both desktops, one source for several front doors

Findings from reading current vendor documentation (21 October 2026). Nothing was built. Each section ends with what is **not shown**.
Formats in this area change often; every claim below names the page it came from and must be re-checked before it is built on.

## Spike 1: signing in to BigQuery without `gcloud`

**What the documents say**
- Google's scope list ([scopes](https://developers.google.com/identity/protocols/oauth2/scopes)) has, for BigQuery, `auth/bigquery` ("view and manage your data"), `auth/cloud-platform` ("see, edit, configure, and delete your Google Cloud data") and `auth/cloud-platform.read-only` ("view your data across Google Cloud services"). `bigquery.readonly` is not listed on that page. The page does not say which scopes are sensitive or restricted; the Cloud Console consent screen marks them.
- Sensitive-scope verification ([page](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)) needs: a verified domain, a public home page and privacy policy on the same domain, a recorded demo of the grant flow, and a written reason for each scope. Review "typically takes 3-5 business days". Restricted scopes have their own, heavier process.
- An app left in Testing mode is limited to listed test users (Google's help page says 100, for the project's lifetime) and shows an unverified-app screen; authorisations by test users expire after seven days ([help](https://support.google.com/cloud/answer/15549945)).

**What it means for Causeline**
- A shared "sign in with Google" app used by strangers would need a domain, a privacy policy, a demo video and a review, and the broad BigQuery scopes are wider than the promise "read-only". **Read-only must come from the user's IAM role** (BigQuery Data Viewer plus Job User on the project that pays for queries), not from the scope. The admin message should name those two roles.
- The 7-day expiry of a testing-mode app matches the weekly re-sign-in pain seen with `gcloud` (`invalid_rapt` is Google's re-authentication policy for some accounts, which applies to any Google sign-in, not only `gcloud`).
- **Recommended order:** (1) keep `gcloud` application-default sign-in as the engineer path, with a clearer message when it expires; (2) offer a **user-created OAuth client** (an admin or the user creates a desktop-app client in their own project, so no third-party review is involved) as the analyst path, guided by the Builder; (3) a shared app only if there is a domain and a privacy policy to put behind it, started early because of the review time.

**Not shown:** that `bigquery` or `cloud-platform` is classed sensitive or restricted today (read it off the consent screen of a real project); the review time in practice (the documents give 3-5 business days for sensitive scopes only); whether a Workspace organisation's re-authentication policy can be avoided by any app.

## Spike 2: a path with no terminal and no installs, on Claude Desktop and Codex desktop

### Claude Desktop (a `.mcpb` extension)
- A `.mcpb` file is a zip with a `manifest.json` and a local stdio server; the user double-clicks it, reviews permissions and settings, and it runs ([Anthropic docs](https://claude.com/docs/connectors/building/mcpb)). Node.js ships with Claude Desktop on macOS and Windows, so no Node install is needed for a Node server. Our server is one bundled file (`causeline-mcp.mjs`, 3.6 MB), which fits.
- The manifest supports `user_config` (a `directory` type for the project folder, `string` for a project id, `sensitive` for secrets) and `${__dirname}`, `${HOME}`, `${user_config.KEY}` substitution ([spec](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)). Server types are `node`, `python`, `binary`, `uv`; platform-specific commands go in `mcp_config.platform_overrides` keyed by `win32` / `darwin`.
- Desktop extension listings in the directory are deprecated; files are installed by hand, and a directory listing goes through a plugin instead.
- **Problem found:** the Toolbox binary is **294 MB** for one platform (`toolbox.exe`). Bundling both platforms would give a very large extension. Better: the server downloads the pinned Toolbox for the user's platform on first run, checks its hash, and caches it under the project home. That also fits the plan's "fetched automatically".
- Instructions to the model: the server already sends `instructions` with the MCP handshake, which every client reads; skills are a separate mechanism that the extension format does not carry.

### Codex desktop
- One configuration is shared by the ChatGPT desktop app, the Codex CLI and the IDE extension: `~/.codex/config.toml`, with `[mcp_servers.<name>]` tables (`command`, `args`, `env`, `startup_timeout_sec` default 10 s, `tool_timeout_sec` default 60 s). A project-level `.codex/config.toml` loads only in trusted projects ([MCP page](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). Servers can also be added in the app's Settings, MCP servers.
- Skills: `SKILL.md` folders in `.agents/skills` (repo and parents) or `$HOME/.agents/skills`, with `name` and `description` frontmatter; **plugins** can bundle skills and MCP servers and work across ChatGPT and Codex ([skills page](https://learn.chatgpt.com/docs/build-skills)).
- Hooks: **on by default** (switch off with `hooks = false` under `[features]`; `codex_hooks` is a deprecated alias). `PreToolUse` can deny shell commands, patches and MCP tool calls; non-managed hooks must be reviewed and trusted with `/hooks`; the page itself calls them "a useful guardrail, not a complete enforcement boundary" ([hooks page](https://learn.chatgpt.com/docs/hooks)). This **corrects** the planning note, which said a flag must be switched on.
- **Problem found:** Codex does not ship a Node runtime for MCP servers. The config needs a `command` that exists. Options: require Node (breaks "no install"), `npx` (needs network and Node), or ship the server as a **single self-contained executable** per platform (Node single-executable build) fetched on first run like Toolbox. The 10-second startup default also needs raising for the Toolbox start.

### Claude Code
Already works through the plugin (`npm run bundle:plugin`): MCP server, skills and the playbooks.

**Not shown:** that an extension actually installs and runs Toolbox from a downloaded path on a clean Windows or macOS machine; that a Node single-executable build of the bundled server runs under Codex desktop; that Codex desktop honours a project config without a terminal; how Claude Desktop treats a server that spawns a child process and opens a local web page (expected to work, not tried). No Codex desktop or Claude Desktop was run in this spike.

## Spike 3: one source, three packagings

| Piece | Claude Code plugin | Claude Desktop extension | Codex (desktop, CLI, IDE) |
|---|---|---|---|
| MCP server entry | plugin config | `manifest.json` `mcp_config` | `[mcp_servers.causeline]` in `config.toml` |
| Runtime | Node on the machine | Node inside Claude Desktop | none provided: single executable, or Node |
| Toolbox | pinned download | download on first run (294 MB per platform is too big to bundle) | same |
| Instructions | skills + server `instructions` | server `instructions` only | `AGENTS.md`, skills in `.agents/skills`, server `instructions` |
| Guardrail against direct queries | plugin hook | none documented for Desktop extensions: rely on the server not exposing free SQL | `PreToolUse` hook in `hooks.json` / `[hooks]` (a guardrail, not a boundary) |
| User settings | environment / config | `user_config` (project folder, project id) | `env` in the server table |
| Distribution | plugin | a `.mcpb` file by hand | files, or a plugin that bundles skills and the server |

**One source** is feasible: the server, the skills text, the instructions text and the playbooks are shared; a small generator (starting from `scripts/bundle-plugin.mjs`) writes the three wrappers. The risky differences are the runtime on Codex, and the guardrail on Claude Desktop, where the only reliable protection is that **the server itself never offers free SQL or write access** and the user's role is read-only.

**Not shown:** the generator itself; evals through Codex and Claude Desktop (the plan requires both to pass before release).

## Go / no-go
- **Go:** the Claude Desktop extension for the analyst path (Node is included), with Toolbox fetched on first run.
- **Go with a condition:** Codex desktop, conditional on a self-contained server executable.
- **Go:** user-created OAuth client as the analyst sign-in; `gcloud` stays as the engineer path.
- **Defer:** a shared sign-in app, until there is a domain and privacy policy.
- **Risk to carry forward:** on any client other than Claude Code the only guardrail is the server's own design; do not rely on hooks alone.
