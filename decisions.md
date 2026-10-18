# Decisions

Technical decisions, with the reason, in the order they were made.

- **The analysis never computes; the agent never decides what is true.** A deterministic runner does every
  number; the agent chooses what to run and explains. Why: answers must be checkable.
- **One file per concern.** `ontology.yaml` (words), `data.yaml` (all SQL), generated tools, playbooks (steps, no SQL),
  expert definitions, runner (maths). Why: a use case should be written without touching the core, and a person who
  does not code should be able to read each file.
- **Tools are generated from the ontology and data definition; the agent only calls them.** Why: no free-form SQL from
  the agent. A sidecar file (`tools.meta.yaml`) says what each tool answers, because Toolbox rejects unknown fields.
- **One slice contract for ratios and totals** (current and baseline numerator, denominator, squared term). Why: the
  runner's maths is shared.
- **Seasonality is part of the method, not an option.** Baselines compare like with like (same weekday, same hour,
  same calendar flags); a period with no comparable baseline is not judged; onboarding tests which cycles the data
  supports. Why: ignoring a repeating pattern produces false findings.
- **The core stays domain-free.** `npm run check:purity` fails if a domain word appears in `core/`, the skills or the
  shared playbooks. Why: the process must transfer to any use case.
- **Experts are explicit (verified or draft) or generic.** A draft says so in every answer. Verification happens only
  through a number the user matched and a past incident the analysis found. Saving again never verifies; changing a
  KPI's formula drops the status.
- **Routing is deterministic.** KPI by name and synonyms, task by keyword, period resolution, a scan strategy for
  vague questions. Fuzzy matching only for a KPI's own name or synonyms of six letters or more.
- **Supporting records are never findings.** Evidence from other tables is labelled "consistent with" and is looked up
  only for the culprit the drill found.
- **Masking checks:** offsetting children, time-slot masking, rate vs mix, small cells; a contrast test decides whether a
  large child is really worse than its siblings.
- **The Builder uses pure-npm SQLite (`sql.js`) for CSV files.** Why: nothing else for a non-coder to install. SQL it
  accepts is a single read-only SELECT.
- **Retired the first example pack from this repository** and kept the contact-centre pack as the worked example.
  Why: the public project is not tied to one domain; the lost trap-type coverage is listed in `PROGRESS.md`.
- **The starter pack (`packs/_template`) is validated by a test.** Why: it is the entry point for a new use case and
  must not rot.
