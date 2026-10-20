import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";
import { newState, readState, slug, writeState, type DataTable } from "@causeline/builder";
import { checkConnection } from "./check.js";
import { googleApi, parseTableRef, type BigQueryApi, type TableRef } from "./builder-data.js";
import { explainBigQueryError } from "./explain.js";

export interface ConnectBigQueryResult {
  connected: boolean;
  /** One plain sentence: what is wrong and what to do, or what was connected. */
  summary: string;
  project?: string;
  location?: string;
  tables: { name: string; rows?: number; gb?: number; columns: { name: string; type: string }[]; kind?: string }[];
  notes: string[];
  /** Connecting reads table descriptions only, never the data. */
  read_bytes: 0;
}

const MAX_TABLES = 20;

/** The project queries are billed to: the environment, else what this workspace was connected with, else the source file. */
export function bigQueryProject(packDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CAUSELINE_BQ_PROJECT) return env.CAUSELINE_BQ_PROJECT;
  const fromState = readState(packDir)?.bigquery?.project;
  if (fromState) return fromState;
  const file = join(packDir, "toolbox", "source.yaml");
  if (existsSync(file)) {
    const d = parse(readFileSync(file, "utf-8")) as { type?: string; project?: unknown } | null;
    if (d?.type === "bigquery" && typeof d.project === "string" && !d.project.includes("${")) return d.project;
  }
  return undefined;
}

/**
 * Connect a workspace to a BigQuery table or dataset: check that this computer is signed in and the project accepts
 * queries, read the table descriptions (free: no data is read), write the Toolbox source and note in `build.json`
 * that this workspace reads BigQuery. The project given is the one queries are billed to; the data may live in
 * another (the public datasets do).
 */
export async function connectBigQuery(opts: { workspace: string; project?: string; location?: string; table?: string; dataset?: string; api?: BigQueryApi }): Promise<ConnectBigQueryResult> {
  const workspace = resolve(opts.workspace);
  const fail = (summary: string): ConnectBigQueryResult => ({ connected: false, summary, tables: [], notes: [], read_bytes: 0 });
  const project = opts.project ?? bigQueryProject(workspace);
  const location = opts.location ?? process.env.CAUSELINE_BQ_LOCATION ?? "US";
  if (!project) return fail("Which Google Cloud project should the queries be billed to? Give its id (project), or set CAUSELINE_BQ_PROJECT.");
  if (!opts.table === !opts.dataset) return fail("Give either a table (project.dataset.table) or a dataset, not both and not neither.");
  const existing = readState(workspace);
  if (existing && (existing.dialect ?? "sqlite") === "sqlite" && existing.tables.length > 0) return fail("This folder already holds the user's own files. Start a new folder for a BigQuery table, so the two are never mixed.");

  if (!opts.api) {
    const c = await checkConnection({ project, location });
    if (!c.ok) return fail(c.summary);
  }
  const api = opts.api ?? googleApi({ project, location });
  let refs: TableRef[];
  let dataset: string | undefined;
  const notes: string[] = [];
  try {
    if (opts.table) refs = [parseTableRef(opts.table, project)];
    else {
      const parts = opts.dataset!.replace(/`/g, "").split(".");
      const ds = parts.length === 2 ? { project: parts[0], dataset: parts[1] } : { project, dataset: parts[0] };
      dataset = `${ds.project}.${ds.dataset}`;
      refs = await api.tables(ds);
      if (refs.length === 0) return fail(`The dataset ${dataset} has no tables this account can see.`);
      if (refs.length > MAX_TABLES) {
        notes.push(`The dataset has ${refs.length} tables; the first ${MAX_TABLES} are connected. Name the ones you need as tables to be precise.`);
        refs = refs.slice(0, MAX_TABLES);
      }
    }
  } catch (e) {
    return fail(explainBigQueryError(e));
  }
  const tables: DataTable[] = [];
  for (const r of refs) {
    try {
      tables.push(await api.table(r));
    } catch (e) {
      return fail(`${r.project}.${r.dataset}.${r.table}: ${explainBigQueryError(e)}`);
    }
  }
  for (const t of tables) {
    if (t.kind === "view") notes.push(`${t.name} is a view: it cannot be sampled, so looking at it reads the whole of what it selects.`);
    if (t.bytes !== undefined && t.bytes > 5e9) notes.push(`${t.name} is ${(t.bytes / 1e9).toFixed(1)} GB: every question reads some part of it, so a limit per question is set when the pack is saved.`);
  }

  mkdirSync(join(workspace, "toolbox"), { recursive: true });
  const source = `${slug(basename(workspace))}-bq`.replace(/_/g, "-");
  writeFileSync(
    join(workspace, "toolbox", "source.yaml"),
    [
      "# The BigQuery source. Queries are billed to this project; read-only access is a matter of the account's permissions.",
      "kind: source",
      `name: ${source}`,
      "type: bigquery",
      `project: ${project}`,
      `location: ${location}`,
      "# Toolbox returns only 50 rows per query unless told otherwise, which would silently cut off any split with more groups.",
      "maxQueryResultRows: 100000",
      "# a hard stop for any single query (bytes billed). Do not set writeMode: blocked: Toolbox then hides every query tool.",
      "maximumBytesBilled: 20000000000",
      "",
    ].join("\n"),
    "utf-8",
  );
  const state = existing ?? newState(source);
  state.source = source;
  state.dialect = "bigquery";
  state.bigquery = { project, location, ...(dataset ? { dataset } : {}) };
  state.tables = tables.map((t) => ({ name: t.name, file: t.name, rows: t.rows ?? 0, columns: t.columns.length, notes: [] }));
  state.profiled = false;
  writeState(workspace, state);

  const biggest = tables.reduce((a, t) => a + (t.bytes ?? 0), 0);
  return {
    connected: true,
    summary: `Connected to ${tables.length} BigQuery table${tables.length === 1 ? "" : "s"} (${(biggest / 1e9).toFixed(1)} GB in all); queries are billed to ${project}. Nothing was read yet: only the tables' descriptions.`,
    project,
    location,
    tables: tables.map((t) => ({ name: t.name, rows: t.rows, ...(t.bytes !== undefined ? { gb: Math.round(t.bytes / 1e8) / 10 } : {}), columns: t.columns.map((c) => ({ name: c.name, type: c.repeated ? `ARRAY<${c.type}>` : c.type })), ...(t.kind ? { kind: t.kind } : {}) })),
    notes,
    read_bytes: 0,
  };
}
