# Causeline in Codex

Two ways to set it up. Both use the same single program, `causeline-mcp` (`causeline-mcp.exe` on Windows), which needs no Node and no other install.

## The one-step way

Put the program somewhere it can stay (for example a `Causeline` folder in your home folder), then run it once with `install codex`. It adds Causeline to Codex's settings, adds its guidance, adds its four skills, and adds a check that keeps data reads to Causeline's tools. It copies each file it changes aside first. `uninstall codex` puts everything back.

Restart Codex afterwards, and open `/hooks` once to review and trust the new check.

## The by-hand way (Codex's own screens)

Settings, MCP servers, Add server:

| Field | Value |
|---|---|
| Name | `causeline` |
| Command | the full path of the `causeline-mcp` program |
| Arguments | none |
| Startup timeout | 60 seconds (the default of 10 is too short on a first start) |

This way gives Codex the tools only. The guidance reaches it through the server itself (`get_guide`), but the skills and the shell check are not added; use the one-step way for those.

## First use

The first question that needs data prepares the data connection software (a one-time download of 150 to 320 MB depending on the computer). Causeline says so in plain words and the question can be asked again a few minutes later. `causeline-mcp doctor` says whether everything is ready.

## Not yet shown

Nothing here has been run inside Codex's own desktop app. The program, the installer and the settings it writes are proved on Windows in a temporary home; macOS and Linux builds come from the release workflow and have not been run. The programs are not code-signed, so Windows SmartScreen or macOS Gatekeeper may warn on first run.
