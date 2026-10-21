import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { ServerConfig } from "./config.js";
import { IntentService } from "./intent.js";
import { registerBigQuery } from "@causeline/connect-bigquery";
import { SignoffScreen } from "./signoff.js";
import { ProjectService } from "./projects.js";
import { acceptSampleTool, addIncidentTool, buildStatusTool, confirmNumberTool, connectBigQueryTool, connectFilesTool, describeDataTool, proposeChecksTool, runChecksTool, signoffStatusTool, playBackTool, reconcileMetricTool, savePackTool, testFactTool, verifyExpertTool, analyzeSeasonalityTool, checkDataTool, generateToolsTool, listPlaybooks, routeTool, runPlaybookTool, scanKpisTool, validatePackTool, type Callers, type RunArgs, type SeasonalityArgs } from "./handlers.js";

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
const connectBigQueryInput = fromJsonSchema<{ table?: string; dataset?: string; project?: string; location?: string }>(
  obj({
    table: { type: "string", description: "One table, as project.dataset.table (or dataset.table when the data is in the billing project). Give this or dataset." },
    dataset: { type: "string", description: "A whole dataset, as project.dataset or dataset: its tables are connected (up to 20)." },
    project: { type: "string", description: "The Google Cloud project the queries are billed to (the user's own). Ask for it; it is remembered for this folder. Not the project that holds the data, which may be a public one." },
    location: { type: "string", description: "Where the data is held (default US)." },
  }),
);
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
const proposeInput = fromJsonSchema<{ kpi: string; odd_period?: { start: string; end: string; name?: string; scope?: Record<string, string> } }>(
  obj({ kpi: { type: "string" }, odd_period: { type: "object", description: "A window the user has a report for, when none of the suggested ones is: {start, end} as YYYY-MM-DD, scope optional ({concept: value} for one part of the data, for example one product), name optional. Use it instead of confirming their number against a check for a different window or part.", properties: { start: { type: "string" }, end: { type: "string" }, name: { type: "string" }, scope: { type: "object", additionalProperties: { type: "string" } } }, required: ["start", "end"] } }, ["kpi"]),
);
const confirmNumberInput = fromJsonSchema<{ kpi: string; check: string; expected: number; source: string; tolerance?: number; flag?: boolean; note?: string }>(
  obj({
    kpi: { type: "string" },
    check: { type: "string", description: "The check id from propose_checks (for example total-1)." },
    expected: { type: "number", description: "The number the user gave from their own report (93.1 means 93.1% for a rate)." },
    source: { type: "string", description: "Which report or system it comes from, in the user's words. Required: a number with no named source does not count." },
    tolerance: { type: "number", description: "Relative difference allowed (default 0.01)." },
    flag: { type: "boolean", description: "Set to record the number and flag it as wrong or doubtful instead of confirming." },
    note: { type: "string", description: "With flag: what looks wrong." },
  }, ["kpi", "check", "expected", "source"]),
);
const acceptSampleInput = fromJsonSchema<{ kpi: string; check: string; note?: string }>(
  obj({
    kpi: { type: "string" },
    check: { type: "string", description: "The check id from propose_checks." },
    note: { type: "string", description: "Anything the user said about why it looks right." },
  }, ["kpi", "check"]),
);
const projectNameInput = fromJsonSchema<{ name: string }>(obj({ name: { type: "string", description: "The project's name as the user says it (for example 'Weekly review')." } }, ["name"]));
const projectOptionalInput = fromJsonSchema<{ name?: string }>(obj({ name: { type: "string", description: "A project by name; leave out for the open one." } }));
const kpiOptional = fromJsonSchema<{ kpi?: string }>(obj({ kpi: { type: "string", description: "One KPI; leave out for all." } }));
const openSignoffInput = fromJsonSchema<{ kpi?: string }>(obj({ kpi: { type: "string", description: "The KPI to show first." } }));
const incidentInput = fromJsonSchema<Record<string, unknown>>(
  obj({
    kpi: { type: "string" },
    period: { type: "string", description: "The period label where it happened. Leave out when you give dates." },
    start_date: { type: "string", description: "Or the first day, YYYY-MM-DD (with end_date)." },
    end_date: { type: "string", description: "Or the last day, YYYY-MM-DD, included." },
    finding: { type: "object", description: "Where the user knows it was: {dimension, value, scope?} for example {dimension: 'kind', value: 'K3', scope: {place: 'P2'}}." },
    question: { type: "string", description: "The question as the user would ask it." },
    mention: { type: "array", items: { type: "string" }, description: "Words the answer should contain." },
    anywhere: { type: "boolean", description: "Set when the analysis may report what the user said among several findings (for example both one value and another that describes the same records), not only first. Say so to the user; the default is that it must be first." },
  }, ["kpi", "finding", "question"]),
);
const verifyInput = fromJsonSchema<{ kpi: string }>(obj({ kpi: { type: "string" } }, ["kpi"]));

const periodSpecSchema = {
  type: "object",
  description:
    "The period as structure, never as text. kind=relative {unit: day|week|month|quarter|year, offset (default 1: how many units back the span ends; 1 = the last complete one, 0 = the current one so far), count (default 1)}: yesterday = day/1/1, last week = week/1/1, last 4 weeks = week/1/4, last 30 days = day/1/30, last month = month/1/1. kind=to_date {unit}: year to date. kind=since {date: YYYY-MM-DD}. kind=calendar {unit: month|quarter|year, index (month 1-12 or quarter 1-4), year?}: Q3 = quarter/3, August = month/8 (no year: the latest one that has begun). kind=range {start, end} as YYYY-MM-DD, both included. kind=label {label}: a period label from get_intent.",
  properties: {
    kind: { enum: ["relative", "to_date", "since", "calendar", "range", "label"] },
    unit: { type: "string" },
    offset: { type: "integer" },
    count: { type: "integer" },
    date: { type: "string" },
    index: { type: "integer" },
    year: { type: "integer" },
    start: { type: "string" },
    end: { type: "string" },
    label: { type: "string" },
  },
  required: ["kind"],
};
const setIntentInput = fromJsonSchema<{ message?: string; patch?: unknown }>(
  obj({
    message: { type: "string", description: "The user's message, as they wrote it (kept so the conversation can be recalled)." },
    patch: {
      type: "object",
      description: "Only what this message changes. null clears a slot; filters merge by concept and null removes one.",
      properties: {
        kpi: { type: ["string", "null"], description: "A KPI name from get_intent, or the words the user used for it." },
        task: { enum: ["value", "compare", "trend", "deep_rca", null], description: "value: the number. compare: two periods (set comparison). trend: movement over time. deep_rca: why it changed and where." },
        period: { anyOf: [periodSpecSchema, { type: "null" }] },
        comparison: { description: "For compare: 'previous' (the period just before), 'same_last_year', or {kind: 'period', period: <a period>} for a named one ('Q3 vs Q2').", anyOf: [{ enum: ["previous", "same_last_year"] }, { type: "object" }, { type: "null" }] },
        aggregation: { type: ["string", "null"], description: "The view: a time level from get_intent ('by day' = day). Leave out to let the analysis choose." },
        filters: { type: "object", description: "Concept -> value, for example {concept_name: 'value'}. Use the concept names from get_intent.", additionalProperties: { type: ["string", "null"] } },
        baseline: { type: ["integer", "null"], description: "How many earlier periods make up what it should have been. Leave out unless the user asks." },
      },
    },
  }, ["patch"]),
);
const recallInput = fromJsonSchema<{ n?: number }>(obj({ n: { type: "integer", description: "The number of the answer to bring back." } }));

const runPlaybookInput =fromJsonSchema<RunArgs>({
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

/**
 * What a model should know before it picks a tool: which of the plugin's skills to follow. Without this a model that is asked to
 * "set up" someone's data can reach for the developer path (hand-written pack files) and show the user YAML.
 */
const INSTRUCTIONS = [
  "Causeline answers 'why did this number change?' with a deterministic analysis, and builds that setup from the user's own data.",
  "If the user has data (files, or a BigQuery table) and no working setup yet, or wants to add a KPI or sign one off: follow the causeline-build skill from the start. It is a conversation in plain words; never show the user YAML, SQL or file paths, never write pack files yourself, and use the build tools (connect_files or connect_bigquery, describe_data, test_fact, save_pack, play_back, propose_checks, confirm_number, verify_expert).",
  "If a setup already exists and the user asks why a KPI moved: follow the causeline-investigate skill. The causeline-onboard skill is only for checking data and seasonality of an existing pack.",
].join("\n");

/** The causeline-mcp tools: analysis, onboarding and the Builder. `callers` supplies the data connection (Toolbox, or a fake in tests). */
registerBigQuery();

export function createServer(cfg: ServerConfig, callers: Callers, screen: SignoffScreen = new SignoffScreen(cfg, callers)): McpServer {
  const server = new McpServer({ name: "causeline-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });

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
        "Start here for any question about a KPI. Maps the user's question to a KPI, a task (value, compare, trend, deep_rca) and an expert, resolves the period, and returns ranked options with the playbook and inputs to run, one plain sentence saying what will be done (announce), and at most one question to ask the user (needs). Say what was chosen before running it so the user can redirect; if needs is set, ask that one question instead of guessing. strategy 'scan' means no KPI was named: call scan_kpis for the period. strategy 'explorer' means no expert covers it: say so, and that the answer is exploratory. Every option carries a status on the ladder (draft, reconciled, calibrated, verified) and the announce sentence says it in words: repeat it. A draft expert has not been checked against the user's own reports; a reconciled one matches them but has not been tested for false alarms or known incidents.",
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
  builder("connect_bigquery", "Connect a BigQuery table", "Connect this folder to a BigQuery table or dataset instead of files. Checks the user is signed in (a sign-in the user has to do themselves is explained in the result) and that the project accepts queries, and reads only the tables' descriptions: no data is read and nothing is billed. Every later step is metered: each statement is priced with a free dry run first, and what each step read is in its result. Never writes to BigQuery. Use a fresh folder; it cannot be mixed with the user's own files.", connectBigQueryInput, (a) => connectBigQueryTool(cfg, a));
  builder("describe_data", "Look at the data", "Profile every table: columns, types, empty and distinct counts, samples, and suggestions (time columns, flags, measures, places and products, tables that join, columns that nest, one belonging to exactly one of another). Suggestions only: ask the user about anything in 'ask' instead of guessing.", null, () => describeDataTool(cfg), true);
  builder("test_fact", "Try a draft SELECT", "Run a draft fact SELECT (one row per event, every column named, joins allowed) against the user's data and see its columns, a sample and the row count. Read-only: anything but a single SELECT is refused. Use it before save_pack.", testFactInput, (a) => testFactTool(cfg, a), true);
  builder("save_pack", "Save the business description", "Check the draft ontology and data definition (shape, how the parts fit, that every SELECT and formula runs on the user's data) and only then write the pack files and generate the query tools. Returns plain-words errors and nothing is written while there are any. Experts are saved as drafts. Never show the user YAML or SQL; use play_back.", saveInput, (a) => savePackTool(cfg, a));
  builder("play_back", "Say the pack in sentences", "The saved pack as numbered plain sentences, and what changed since the user last confirmed. Read them to the user and ask if each is right. Call with confirm=true only after the user agrees; what they confirmed is exactly what the system uses.", playBackInput, (a) => playBackTool(cfg, a));
  builder("reconcile_metric", "Match a KPI to a number the user knows", "Compute a KPI for a period and compare with a number from the user's own report. A match is stored as a confirmed number; a mismatch returns both numbers and where to look. A KPI is only reconciled once at least three confirmed numbers, from at least two periods and two kinds, each from a named source, are in with passing automatic checks, so one number never moves it.", reconcileInput, (a) => reconcileMetricTool(cfg, callers, a));
  builder("list_projects", "List the user's projects", "The user's projects by name, which one is open, and when each was last opened. Call it at the start of a session when the user says 'my project' or when nothing is open. Never show folder paths.", null, () => projects.list(), true);
  builder("create_project", "Start a new project", "Make a project with the name the user gives (for example 'Weekly review') and open it; everything the Builder makes from here on is saved in it and is there next session. Ask the user for the name; do not invent one. Returns where the setup stands.", projectNameInput, async (a: { name: string }) => projects.create(a.name));
  builder("open_project", "Open one of the user's projects", "Open a project by name. It becomes the project every other tool works on, and the question being built is cleared. Returns where the setup stands: the KPIs and how far each is trusted, the experts, and what to do next. Say that in plain words.", projectNameInput, async (a: { name: string }) => projects.open(a.name));
  builder("project_summary", "Where a project stands", "The KPIs and how far each is trusted (draft, reconciled, calibrated, verified), the experts, the data connected, recent changes of rung and what to do next, for the open project or one named. Reads files only; it runs no query.", projectOptionalInput, (a: { name?: string }) => projects.summary(a?.name), true);
  builder("propose_checks", "Suggest numbers to check", "For a KPI: the numbers worth setting against the user's own reports, from different angles (the whole business over the last complete period, the biggest part of a hierarchy and of one other concept, one day, and an odd period they name). Returns only the questions to ask, not our numbers: ask the user for each number from their own report, and which report it is, BEFORE showing anything. Then record each with confirm_number.", proposeInput, async (a) => proposeChecksTool(cfg, callers, a));
  builder("confirm_number", "Record a number from the user's report", "Give the user's number for one check and where it comes from. If it matches ours within the tolerance it is confirmed; otherwise nothing is confirmed and both numbers come back with where to look. Ours is revealed in the answer: say both. At least three confirmed numbers from at least two periods and two kinds, from named sources, plus passing automatic checks, make a KPI reconciled; fewer leave it a draft and the answer says what is still needed. Never confirm a number the user did not give.", confirmNumberInput, async (a) => confirmNumberTool(cfg, callers, a));
  builder("accept_sample", "Accept a number as plausible", "Only when the user has no exact figure to check against: show them the number the tools give for a check and, if they say it looks right, record it as a plausible sample. It never counts toward a rung; the KPI stays a draft marked 'numbers not confirmed', and answers from it say so. Prefer confirm_number whenever the user can give a number from a report.", acceptSampleInput, async (a) => acceptSampleTool(cfg, a));
  builder("signoff_status", "Where each KPI stands", "The ladder for one KPI or all: draft, reconciled, calibrated or verified (and whether its numbers were only a plausible sample), what stands between it and the next step in plain words, the automatic checks, and each check with its state. Our number is shown only for a check the user has already answered.", kpiOptional, (a) => signoffStatusTool(cfg, a), true);
  builder("run_checks", "Re-run the stored checks", "Work out again every confirmed number and the automatic checks. Use it after the model changed (a changed KPI drops back to draft) or to refresh a sign-off: a KPI is reconciled again only if every stored number still matches. Numbers that no longer match go back to pending with the new figure.", verifyInput, async (a) => runChecksTool(cfg, callers, a));
  builder("open_signoff", "Open the sign-off screen", "Open a page on this computer where the user can enter numbers from their own reports, see ours beside them, and confirm or flag each one. Returns its address (give it to the user if the browser did not open). Everything on it is also available through confirm_number; offer it when there are several numbers to check or the user would rather click than type.", openSignoffInput, async (a: { kpi?: string }) => ({ ...(await screen.open(a?.kpi)), note: "The page is local to this computer and works until this session ends. Anything the user confirms there shows in signoff_status." }));
  builder("add_incident", "Record a past incident", "Remember a past incident the user knows the cause of (period, where it was, how they would ask) as a test case run on their real data. Ask the user for one per KPI.", incidentInput, (a) => addIncidentTool(cfg, a as never));
  builder("verify_expert", "Check an expert against the user's incident", "Run the KPI's recorded incidents through the analysis. Needs a reconciled KPI (see confirm_number). When every incident is found where the user said, the check is stored; the expert becomes verified only once it has also been calibrated over ordinary past periods, so say what is still missing. Say plainly what failed otherwise.", verifyInput, (a) => verifyExpertTool(cfg, a));

  // --- the running intent: a question built up over messages, checked against the data, then run ------------------------
  const intent = new IntentService(cfg, callers);
  const projects = new ProjectService(cfg, callers, () => intent.reset());
  builder("get_intent", "Read the question so far", "Start of any question about a KPI. Returns everything you need to fill the intent in correctly: today's date and what the data covers, the KPIs (with other names people use), the concepts you can filter by, the views (time levels), recent period labels, the intent built so far, what the user said since the last answer, and the numbered answers so far. Read it before calling set_intent.", null, () => intent.get(), true);
  builder("set_intent", "Update the question", "Record the user's message and the change it makes to the intent. Fill in only what they said; leave other slots out to keep them, set a slot to null to clear it, and set a filter to null to drop it. You never compute dates: say them as the period structure and the code resolves them against today and the data. Returns either the question to ask the user (exactly one), or the intent read back in plain words for the user to confirm. A new KPI with the rest unchanged is a topic switch: the result says what carried over; tell the user.", setIntentInput, (a) => intent.set(a));
  builder("run_intent", "Run the question", "Run the intent once set_intent says it is ready (it re-checks, and refuses with the one question to ask if anything is missing or unclear). Returns the full result, the play-back and any notes. Explain the result using only what it contains. The intent is kept so the user can refine it.", null, () => intent.run());
  builder("recall", "Go back to an earlier answer", "Without n: the numbered list of answers so far. With n: bring that answer's question back as the active intent so the user can adjust it ('the same, for another value').", recallInput, (a) => intent.recall(a), true);
  builder("start_over", "Forget the question being built", "Clear the intent being built (for a clearly new question where nothing should carry over). The answers so far are kept and can be recalled.", null, () => intent.startOver());
  builder("check_connection", "Can the data be reached?", "For a pack that reads a cloud database: whether this computer is signed in, the project accepts queries and the dataset can be read, in plain words with what to do when not. Call it when a run fails to connect or before the first question on a new database.", null, () => intent.checkConnection(), true);

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
