import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { ServerConfig } from "./config.js";
import { addIncidentTool, buildStatusTool, connectFilesTool, describeDataTool, playBackTool, reconcileMetricTool, savePackTool, testFactTool, verifyExpertTool, analyzeSeasonalityTool, checkDataTool, generateToolsTool, listPlaybooks, routeTool, runPlaybookTool, scanKpisTool, validatePackTool, type Callers, type RunArgs, type SeasonalityArgs } from "./handlers.js";

const text = (data: unknown) => JSON.stringify(data, null, 2);
const ok = (data: object) => ({ content: [{ type: "text" as const, text: text(data) }], structuredContent: data as Record<string, unknown> });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });

/** Run a handler and turn anything it throws into a tool error the agent can read. */
async function guard(fn: () => object | Promise<object>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

const seasonalityInput = fromJsonSchema<SeasonalityArgs>({
  type: "object",
  properties: {
    metrics: { type: "array", items: { type: "string" }, description: "Limit the analysis to these metrics (default: all ratio and sum metrics)." },
    backtest: { type: "boolean", description: "Also replay the data's recent periods with and without the recommended seasonality. Slow (minutes); use it once the user wants evidence of the effect." },
  },
});

const routeInput = fromJsonSchema<{ question: string }>({
  type: "object",
  properties: { question: { type: "string", description: "The user's question, in their own words." } },
  required: ["question"],
});

const scanInput = fromJsonSchema<{ period: string }>({
  type: "object",
  properties: { period: { type: "string", description: "A period label at the top time level, as route returned it." } },
  required: ["period"],
});

const obj = (properties: Record<string, unknown>, required: string[] = []): never => ({ type: "object" as const, properties, required }) as never;
const connectInput = fromJsonSchema<{ files: string[] }>(obj({ files: { type: "array", items: { type: "string" }, description: "Full paths of the user's CSV files." } }, ["files"]));
const testFactInput = fromJsonSchema<{ sql: string; time?: string; concepts?: string[] }>(
  obj({ sql: { type: "string", description: "One SELECT over the connected tables: one row per event, every column named." }, time: { type: "string", description: "The column that holds when the event happened." }, concepts: { type: "array", items: { type: "string" }, description: "Columns that must be present (places, products, people)." } }, ["sql"]),
);
const saveInput = fromJsonSchema<{ ontology: unknown; data: unknown; agents?: unknown[] }>(
  obj({
    ontology: { type: "object", description: "The business vocabulary: time {levels, seasonality}, hierarchies, dimensions, metrics (type, direction, min_volume, description, synonyms). No tables, columns or SQL." },
    data: { type: "object", description: "Where the numbers come from: source, facts {name: {sql, time, concepts, time_levels?, slots?}}, metrics {kpi: {fact, numerator, denominator} or {fact, value}}, evidence?." },
    agents: { type: "array", items: { type: "object" }, description: "Optional experts: name, kpi, task, playbook?, examples. They are saved as drafts." },
  }, ["ontology", "data"]),
);
const playBackInput = fromJsonSchema<{ confirm?: boolean }>(obj({ confirm: { type: "boolean", description: "Set only after the user has read the sentences and said they are right." } }));
const reconcileInput = fromJsonSchema<{ kpi: string; period: string; expected: number; tolerance?: number }>(
  obj({ kpi: { type: "string" }, period: { type: "string", description: "A period label, or words like 'week 10'." }, expected: { type: "number", description: "The number the user already knows from their own report (93.1 means 93.1% for a rate)." }, tolerance: { type: "number", description: "Relative difference allowed (default 0.01)." } }, ["kpi", "period", "expected"]),
);
const incidentInput = fromJsonSchema<Record<string, unknown>>(
  obj({
    kpi: { type: "string" },
    period: { type: "string", description: "The period label where it happened." },
    finding: { type: "object", description: "Where the user knows it was: {dimension, value, scope?} for example {dimension: 'kind', value: 'K3', scope: {place: 'P2'}}." },
    question: { type: "string", description: "The question as the user would ask it." },
    mention: { type: "array", items: { type: "string" }, description: "Words the answer should contain." },
  }, ["kpi", "period", "finding", "question"]),
);
const verifyInput = fromJsonSchema<{ kpi: string }>(obj({ kpi: { type: "string" } }, ["kpi"]));

const runPlaybookInput = fromJsonSchema<RunArgs>({
  type: "object",
  properties: {
    name: { type: "string", description: "Playbook name, as returned by list_playbooks (for example metric_change)." },
    inputs: {
      type: "object",
      description: "The playbook's inputs, by name. For metric_change: metric (a metric from the ontology), period (a bucket label at the top time level) and optionally baseline (number of earlier periods to compare against).",
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
  },
  required: ["name"],
});

/** The causeline-mcp tools: analysis, onboarding and the Builder. `callers` supplies the data connection (Toolbox, or a fake in tests). */
export function createServer(cfg: ServerConfig, callers: Callers): McpServer {
  const server = new McpServer({ name: "causeline-mcp", version: "0.1.0" });

  server.registerTool(
    "list_playbooks",
    {
      title: "List playbooks",
      description:
        "List the root-cause playbooks available for this pack (name, description, inputs) together with a summary of the pack's ontology: its metrics, time levels, hierarchies and dimensions. Call this first to choose a playbook and to see which metric names and period format to use.",
      annotations: { readOnlyHint: true },
    },
    async () => guard(() => listPlaybooks(cfg)),
  );

  server.registerTool(
    "route",
    {
      title: "Route a question",
      description:
        "Start here for any question about a KPI. Maps the user's question to a KPI, a task (value, compare, trend, deep_rca) and an expert, resolves the period, and returns ranked options with the playbook and inputs to run, one plain sentence saying what will be done (announce), and at most one question to ask the user (needs). Say what was chosen before running it so the user can redirect; if needs is set, ask that one question instead of guessing. strategy 'scan' means no KPI was named: call scan_kpis for the period. strategy 'explorer' means no expert covers it: say so, and that the answer is exploratory. A draft expert is a generic template that has not been verified; say so.",
      inputSchema: routeInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => guard(() => routeTool(cfg, callers, args)),
  );

  server.registerTool(
    "scan_kpis",
    {
      title: "Scan every KPI",
      description:
        "For a vague question with no KPI named ('why was last week bad?'): check every KPI for a period against what it should have been (seasonally adjusted) and list the ones that moved, worst first. Then run a deep dive (route, then run_playbook) for each KPI in 'moved'; report that the others did not move significantly.",
      inputSchema: scanInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => guard(() => scanKpisTool(cfg, callers, args)),
  );

  server.registerTool(
    "run_playbook",
    {
      title: "Run a playbook",
      description:
        "Run a root-cause playbook against the data and return its result.json: the headline change, ranked findings (where and when a metric changed), the path the drill took with the decision at every level, masking flags, the data-quality outcome and every query that was run. All numbers come from this result; do not state figures that are not in it. If the run is 'stopped', report the stopped_reason and stopped_detail rather than guessing a cause.",
      inputSchema: runPlaybookInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => guard(() => runPlaybookTool(cfg, callers, args)),
  );

  server.registerTool(
    "validate_pack",
    {
      title: "Validate the pack",
      description:
        "Check the pack's files together (ontology.yaml, data.yaml, playbooks and the generated tools): that each parses, that every metric has a formula, every concept is a column of its fact, every evidence source is defined, and that the generated query tools are up to date. Messages name the file and the thing to fix. Checks against the data itself (single parent per child, time gaps, value ranges, volume) are the separate check_data tool.",
      annotations: { readOnlyHint: true },
    },
    async () => guard(() => validatePackTool(cfg)),
  );

  server.registerTool(
    "analyze_seasonality",
    {
      title: "Analyse seasonality",
      description:
        "Onboarding: test every metric against every candidate cycle (weekday, hour of day, half hour, day of month, month of year) and every calendar flag, and recommend the `time.seasonality` block. A cycle is seasonal only if the pattern is statistically real AND large enough to matter; a cycle the history is too short to test is reported as cannot_assess with the count, never as 'not seasonal'. Deterministic. Explain the result to the user and confirm each field with them before editing ontology.yaml; do not apply it silently.",
      inputSchema: seasonalityInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => guard(() => analyzeSeasonalityTool(cfg, callers, args)),
  );

  server.registerTool(
    "check_data",
    {
      title: "Check the data",
      description:
        "Onboarding: deterministic checks of the data against the ontology: every child has a single parent, no gaps or near-empty days in time, no NULL keys, sane value ranges, enough history for a baseline, and levels thick enough to judge. Returns pass/warn/fail per check with the numbers. Fix failures before trusting any analysis.",
      annotations: { readOnlyHint: true },
    },
    async () => guard(() => checkDataTool(cfg, callers)),
  );

  const builder = (name: string, title: string, description: string, inputSchema: unknown, run: (args: never) => object | Promise<object>, readOnly = false) =>
    server.registerTool(name, { title, description, ...(inputSchema ? { inputSchema: inputSchema as never } : {}), annotations: { readOnlyHint: readOnly } }, (async (args: never) => guard(() => run(args))) as never);

  builder("build_status", "Where the build stands", "Building a pack from the user's files: what is done, what is not, and the one next step, in plain words. Call it first in any session that is setting up data; it lets a conversation stop and resume.", null, () => buildStatusTool(cfg), true);
  builder("connect_files", "Connect the user's files", "Load the user's CSV files into a local database (one table per file; types come from the data; dates become ISO text). Nothing leaves this machine. Report what it did and any note it returns (renamed columns, dates it could not read) to the user in plain words.", connectInput, (a) => connectFilesTool(cfg, a));
  builder("describe_data", "Look at the data", "Profile every table: columns, types, empty and distinct counts, samples, and suggestions (time columns, flags, measures, places and products, tables that join, columns that nest, one belonging to exactly one of another). Suggestions only: ask the user about anything in 'ask' instead of guessing.", null, () => describeDataTool(cfg), true);
  builder("test_fact", "Try a draft SELECT", "Run a draft fact SELECT (one row per event, every column named, joins allowed) against the user's data and see its columns, a sample and the row count. Read-only: anything but a single SELECT is refused. Use it before save_pack.", testFactInput, (a) => testFactTool(cfg, a), true);
  builder("save_pack", "Save the business description", "Check the draft ontology and data definition (shape, how the parts fit, that every SELECT and formula runs on the user's data) and only then write the pack files and generate the query tools. Returns plain-words errors and nothing is written while there are any. Experts are saved as drafts. Never show the user YAML or SQL; use play_back.", saveInput, (a) => savePackTool(cfg, a));
  builder("play_back", "Say the pack in sentences", "The saved pack as numbered plain sentences, and what changed since the user last confirmed. Read them to the user and ask if each is right. Call with confirm=true only after the user agrees; what they confirmed is exactly what the system uses.", playBackInput, (a) => playBackTool(cfg, a));
  builder("reconcile_metric", "Match a KPI to a number the user knows", "Compute a KPI for a period and compare with a number from the user's own report. A match marks the KPI reconciled; a mismatch returns both numbers and where to look. A KPI that has not matched cannot have a verified expert.", reconcileInput, (a) => reconcileMetricTool(cfg, callers, a));
  builder("add_incident", "Record a past incident", "Remember a past incident the user knows the cause of (period, where it was, how they would ask) as a test case run on their real data. Ask the user for one per KPI.", incidentInput, (a) => addIncidentTool(cfg, a as never));
  builder("verify_expert", "Check an expert against the user's incident", "Run the KPI's recorded incidents through the analysis. Only if the KPI is reconciled and every incident is found where the user said does the expert become verified. Say plainly what failed otherwise.", verifyInput, (a) => verifyExpertTool(cfg, a));

  server.registerTool(
    "generate_tools",
    {
      title: "Generate query tools",
      description: "Regenerate the pack's query tools (toolbox/tools.generated.yaml) and their index (tools.meta.yaml) from ontology.yaml and data.yaml. Toolbox picks the change up automatically. Run this after editing either file.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => guard(() => generateToolsTool(cfg)),
  );

  return server;
}
