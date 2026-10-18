# Starting a new use case

A pack is the only place a use case's words live. The analysis (`core/`), the skills and the shared playbooks
know nothing about your business.

| File | Holds | Who writes it |
|---|---|---|
| `ontology.yaml` | what things are called: time levels, places, KPIs | you, by describing the business (the Builder writes it) |
| `data.yaml` | where the numbers come from, as SELECTs and formulas | the Builder, checked against your data |
| `toolbox/`, `tools.meta.yaml` | generated query tools | `causeline generate` (never by hand) |
| `agents/*.yaml` | which KPI each expert covers, and whether it is verified | the Builder |
| `evals/cases.yaml` | planted problems the analysis must find | you or the Builder, from a past incident you know the cause of |

Two ways to start: have the Builder do it by conversation (point it at your files), or copy this folder,
edit the two YAML files, then run `causeline generate --pack packs/<name>` and `causeline eval --pack packs/<name>`.
