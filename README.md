# Causeline

**Root-cause analysis you can audit.**

Explainable root-cause analysis on your data: every number checked, every conclusion traced.

Causeline finds where, when and why a KPI changed. A deterministic runner does all the arithmetic; a language-model
agent chooses what to run and explains the result, but never computes a number. The same process works for any use
case: your business words live in one folder (a *pack*), and nothing else in the project knows what you measure.

## What Causeline is, and is not

- **Is:** explainable root-cause analysis of metric changes, with checked numbers and an evidence trail.
- **Is not:** a fraud or financial-crime detection system, or a replacement for monitoring or surveillance tools.

## Status

Early and under active development. What works today: the runner (drill by place and time, rate vs mix,
like-for-like seasonality, masking checks, evidence from other tables), the router, the Builder (CSV files to a
checked pack by conversation), an MCP server and a Claude Code plugin, and an eval harness with planted faults. One
worked example pack ships (a contact centre, synthetic data). Planned next: a BigQuery data source, multi-point
sign-off of each KPI, branching playbooks, and more example packs. See `PROGRESS.md`.

## How it is built (and why it is not tied to one use case)

| Layer | File or package | Holds |
|---|---|---|
| Vocabulary | `ontology.yaml` | what time levels, places and KPIs are called. No tables or SQL |
| Data | `data.yaml` | the only file with SQL: facts, KPI formulas, evidence sources |
| Tools | generated Toolbox tools + `tools.meta.yaml` | what each query answers; never written by hand |
| Playbooks | `playbooks/*.yaml` | the steps of an investigation. No SQL, no domain words |
| Experts | `agents/*.yaml` | which KPI an expert covers, and whether it is `verified` or a `draft` |
| Runner | `core/runner` | all the maths, in plain TypeScript |
| Router | `core/router` | picks KPI, task and period from a question, deterministically |
| Builder | `core/builder` | turns a folder of files into a checked pack, by conversation |

`npm run check:purity` fails the build if a domain word appears in `core/`, the skills or the shared playbooks.
To start a new use case, copy `packs/_template` or let the Builder write it with you.

## Using it with your own data

You need Node.js, the pinned [MCP Toolbox](https://github.com/googleapis/mcp-toolbox) binary (below) and Claude Code
with this repo's plugin (`clients/claude-code`, assembled by `npm run bundle:plugin`). After that no Python, YAML or
command line is needed. Point the plugin at an empty folder (`CAUSELINE_PACK`) and talk:

1. **Connect:** "I have these CSV files." The Builder loads them locally and says in plain words what it found.
2. **Describe the business:** you say what you watch and how it is worked out; the agent writes it down, tests that it
   runs on your data, and reads it back as sentences until you say each one is right.
3. **Check it:** you give one number you know from your own report (it must match) and one past problem whose cause
   you know (the analysis must find it). Only then is the expert called *verified*; until then answers say they are drafts.
4. **Ask:** "Why did the service level drop last Tuesday?" The router picks the KPI and the steps, says what it chose,
   and the answer separates what the data shows from what is only consistent with it.

The `causeline-build` skill scripts this. Today it reads CSV only.

## Contributor setup

- Node.js 18+ (developed against 20.12.2)
- Python 3.10+ (stdlib only): the synthetic data generators
- [DuckDB CLI](https://duckdb.org/install/): loader for the shipped synthetic pack
- [MCP Toolbox for Databases](https://github.com/googleapis/mcp-toolbox), **pinned to v1.14.0**

Windows (PowerShell):

```powershell
winget install DuckDB.cli
$VERSION = "1.14.0"
curl.exe -o toolbox.exe "https://storage.googleapis.com/mcp-toolbox-for-databases/v$VERSION/windows/amd64/toolbox.exe"
```

macOS and Linux (bash/zsh):

```bash
brew install duckdb                      # macOS; on Linux use your package manager or the release from duckdb.org
VERSION=1.14.0
OS=darwin; ARCH=arm64                    # darwin/amd64 for Intel Macs, linux/amd64 on Linux
curl -o toolbox "https://storage.googleapis.com/mcp-toolbox-for-databases/v$VERSION/$OS/$ARCH/toolbox"
chmod +x toolbox
```

Keep the `toolbox` binary at the repo root (gitignored), or set `CAUSELINE_TOOLBOX`.

```bash
npm ci
npm run build
npm test                    # unit tests
npm run check:purity        # the core stays domain-free
npm run eval                # planted-fault cases for the example pack, runner level (about 2 minutes)
node core/cli/dist/src/main.js eval --pack packs/contact-centre --routing   # question routing
npm run test:integration    # end to end over stdio against a real Toolbox (needs Python, DuckDB, Toolbox)
npm run bundle:plugin       # assemble the Claude Code plugin
```

Evals can also be run through an agent (`--agent claude-code --no-bare`) to score how well it explains a result;
`--bare` is reproducible and needs `ANTHROPIC_API_KEY`.

## Repo layout

```
core/schema/     # Zod schemas: ontology, data, playbook, result, eval cases, pack validation
core/generate/   # ontology + data definition -> Toolbox tools
core/runner/     # the maths: drill, decomposition, masking checks, seasonality, evidence
core/router/     # question -> KPI, task, period, expert
core/onboard/    # data checks and seasonality analysis
core/builder/    # files -> checked pack, by conversation
core/eval/       # planted-fault scoring
core/mcp-server/ # the MCP server (causeline-mcp)
core/cli/        # the `causeline` command
playbooks/       # shared playbooks: metric_change, value, trend, compare
skills/          # causeline-investigate, causeline-onboard, causeline-build
packs/_template  # the starting point for a new use case
packs/contact-centre  # worked example, with synthetic data and planted faults
clients/claude-code   # the plugin
```

## License

MIT. See `LICENSE`.
