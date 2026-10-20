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
like-for-like seasonality, masking checks, evidence from other tables), questions about any date range, the router,
a running **intent** (a question built over several messages, checked against the data and read back in plain words
before anything runs), the Builder (your own CSV files or a BigQuery table to a checked pack by conversation), a
**sign-off** of each KPI against numbers from your own reports (draft, provisional, verified; in the chat or on a local
page), an MCP server and a Claude Code plugin, and an eval harness. Data can live in a local database or in **BigQuery**,
with a cost budget per question. Two example packs ship: a contact centre (synthetic data, identical answers on both
databases) and consumer complaints (the CFPB's public data, built by conversation and signed off against the CFPB's own
published counts). Every deep dive carries a table of who contributed how much, judged against their own history (new, unusual or usual), and
the two real incidents the analysis once missed (a bank's sales-practices week; a data-breach week) are now found. Planned next:
branching playbooks and hand-offs between KPIs, a minimal explorer, and easier setup. See `PROGRESS.md`; the proof for each step is in `docs/evidence/`.

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
| Intent | `core/intent` | the structure an agent fills in (KPI, task, period, filters); resolves "last 4 weeks" to dates, checks every value against the data, asks one question at a time |
| Builder | `core/builder` | turns a folder of files into a checked pack, by conversation |

`npm run check:purity` fails the build if a domain word appears in `core/`, the skills or the shared playbooks.
To start a new use case, copy `packs/_template` or let the Builder write it with you.

## Using it with your own data

You need Node.js, the pinned [MCP Toolbox](https://github.com/googleapis/mcp-toolbox) binary (below) and Claude Code
with this repo's plugin (`clients/claude-code`, assembled by `npm run bundle:plugin`). After that no Python, YAML or
command line is needed. Point the plugin at an empty folder (`CAUSELINE_PACK`) and talk:

1. **Connect:** "I have these CSV files" (or a BigQuery table). The Builder loads them locally and says in plain words what it found.
2. **Describe the business:** you say what you watch and how it is worked out; the agent writes it down, tests that it
   runs on your data, and reads it back as sentences until you say each one is right.
3. **Check it:** for each KPI you give numbers you know from your own reports, from at least two angles (the whole
   business for a week, one part of it, one day), and say which report each comes from; your number comes first and ours is
   shown after. In the chat, or on a local page (`open_signoff`), you confirm or flag each. A KPI is *verified* only when
   the automatic checks pass and two angles match; if the numbers for some days disagree with another KPI's, they are set aside.
   You also give one past problem whose cause you know (the analysis must find it). Only then is the expert *verified*.
4. **Ask:** "Why did the service level drop last Tuesday?" The router picks the KPI and the steps, says what it chose,
   and the answer separates what the data shows from what is only consistent with it.

The `causeline-build` skill scripts this, for CSV files or a BigQuery table (see below).

## Using it with BigQuery

A pack can read BigQuery instead of a local database. Causeline never stores your data and never writes to it; it
sends read-only queries through Toolbox and reports how much each question read.

1. Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) and sign in for applications:
   `gcloud auth application-default login` (a separate login from `gcloud auth login`). Signing in without
   the CLI is planned.
2. Tell Causeline which project to bill: set `CAUSELINE_BQ_PROJECT` to its id. Optional: `CAUSELINE_BQ_BUDGET_GB`
   (the most one question may read; default 5, `0` for no limit).
3. Use a pack whose `data.yaml` says `dialect: bigquery` (see `packs/contact-centre/data.bigquery.yaml` and its
   `toolbox.bigquery/source.yaml`). The source must set `maxQueryResultRows`; without it Toolbox quietly returns
   only 50 rows, and Causeline refuses to start.
4. Ask the `check_connection` tool (or just ask a question): a missing sign-in, project or dataset is reported in a
   sentence that says what to do.

Every generated query is priced with BigQuery's free dry run before it runs. If a question would pass the budget it
is stopped, and the result says how much was read and the estimated cost (an upper bound, at list price).

The Builder can start from a BigQuery table instead of files: say which table and which project to bill, and it connects, looks at the
table (without reading free-text columns, and on a sample if the whole would be too much), and saves a pack with a per-pack limit on
what one question may read. Each KPI is then signed off against numbers from your own reports, from at least two angles, in the chat or
on a local sign-off page (`node scripts/signoff-demo.mjs --hands-on` shows it). `node scripts/bigquery-build-demo.mjs --example` plays
the whole path on your own project.

To try the example pack on BigQuery (this creates small datasets named `causeline_eval_*` in your project):

```powershell
$env:CAUSELINE_TARGET = "bigquery"; $env:CAUSELINE_BQ_PROJECT = "<your project id>"
npm run eval                                   # 18 cases, about 1.3 GB read in total
node scripts/intent-demo.mjs                   # a scripted multi-message conversation
```

## Asking questions over several messages

Under the hood, each question becomes an *intent*: KPI, task (value, compare, trend, deep dive), period,
comparison, view (day, week, ...) and filters. The agent fills it in from what you say; code works out the dates
(weeks run Monday to Sunday, periods never include today), looks every filter value up in your data (a near
spelling is offered, never guessed), and reads it back before running, for example *"A deep dive into service level
(team team_05) for 16–22 February 2026, by day: what changed, and why."* Follow-ups change one thing ("now by day",
"and call volume?"); you can go back to an earlier answer or start over.

## Contributor setup

- Node.js 20 or 22 (CI runs both)
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
node core/cli/dist/src/main.js eval --pack packs/contact-centre --intents   # conversations to resolved intents
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
core/intent/     # the question as a structure: natural periods to dates, checks, play-back, session
core/connect-bigquery/  # BigQuery: dry-run pricing, cost budget, connection check
core/onboard/    # data checks and seasonality analysis
core/builder/    # files -> checked pack, by conversation
core/eval/       # planted-fault scoring
core/mcp-server/ # the MCP server (causeline-mcp)
core/cli/        # the `causeline` command
playbooks/       # shared playbooks: metric_change, value, trend, compare
skills/          # causeline-investigate, causeline-onboard, causeline-build
packs/_template  # the starting point for a new use case
packs/contact-centre  # worked example, with synthetic data and planted faults
packs/complaints      # the CFPB's public complaints: built by conversation, signed off against published counts, real incidents
clients/claude-code   # the plugin
```

## License

MIT. See `LICENSE`.
