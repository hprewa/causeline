# Getting Causeline running (for analysts)

You do not need a terminal, Node, or any code for Claude Desktop. Pick the assistant you already use.

## Claude Desktop

1. Download `causeline-<version>.mcpb`.
2. Double-click it. Claude Desktop shows an install screen.
3. It asks where to keep your Causeline projects (the suggestion is a `Causeline` folder in your home folder) and, optionally, a BigQuery project name. Accept the suggestion if unsure.
4. Start a chat and say: **"Check that Causeline is ready."**

## Codex

1. Download the `causeline-mcp` program for your computer and put it in a folder that stays (for example a `Causeline` folder in your home folder).
2. Run it once with `install codex`. On Windows, open the Run box (Windows key + R) and type the full path to the program followed by ` install codex`. It prints what it changed and keeps a copy of every file it touched.
3. Restart Codex. Open `/hooks` once and trust the Causeline check.
4. In a chat say: **"Check that Causeline is ready."**

If you prefer Codex's own screens, `clients/codex/README.md` lists the values to type under Settings, MCP servers.

## Claude Code

Install the Causeline plugin. Node is needed for the plugin; the Codex program above needs nothing. If you are comfortable with a terminal, the engineer path does it for you: clone the repository, run `npm install`, then `npm run init -- --client claude-code` (or `codex`, or `desktop`). It builds Causeline, keeps a copy of it in your Causeline folder and sets the client up with the client's own commands; running it again changes nothing.

## The first time

The first question that needs data prepares the data connection software: a one-time download of 150 to 320 MB depending on your computer, a few minutes on a normal connection. The assistant says so, with a percentage. Ask again a few minutes later. You will not be asked to download anything yourself.

## If it says "not ready"

| It says | What to do |
|---|---|
| Preparing the data connection | Wait and ask again. |
| It cannot reach the download | Connect to the internet, or ask IT to allow `storage.googleapis.com`. Company proxies are not handled yet. |
| Sign-in to BigQuery is needed or expired | Sign in with your Google account when asked; if your organisation blocks it, ask your administrator for access to the project. |
| Your computer is not supported | Linux on ARM has no data connection build yet. |

## Removing it

Claude Desktop: remove the extension in its settings. Codex: run the program with `uninstall codex`; your own settings are put back exactly as they were. Your projects stay in your Causeline folder until you delete it.

## What has and has not been tried

Tested on Windows in a clean temporary home: the extension's contents launched as its manifest says, and the single program with no Node on the machine. **Not yet tried:** a real Claude Desktop or Codex app installing these, macOS, Linux. The files are not signed, so Windows or macOS may warn you the first time; that is expected for now.
