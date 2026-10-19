import { completeBuckets } from "@causeline/router";
import { ToolIndex, type ToolCaller } from "@causeline/runner";
import type { DataDefs, Ontology, ToolsMeta } from "@causeline/schema";
import type { IntentEnv } from "./validate.js";

export interface IntentEnvOptions {
  ontology: Ontology;
  data: Pick<DataDefs, "metrics" | "as_of">;
  meta: ToolsMeta;
  tools: ToolCaller;
  /** The real date (YYYY-MM-DD). Defaults to the system clock; tests and evals pin it. */
  today?: string;
}

/**
 * Read what intent is checked against from the pack's data: how far it reaches, the labels of its top time
 * level, and (on demand) the values each concept takes. Costs one extent query and one series query up front;
 * each concept is looked up once, when a filter first names it.
 */
export async function intentEnv(opts: IntentEnvOptions): Promise<IntentEnv> {
  const index = new ToolIndex(opts.meta);
  const metric = Object.keys(opts.data.metrics)[0];
  const counts = (await opts.tools.call(index.extent(metric), {}, "intent"))[0];
  const start = String(counts.min_ts).slice(0, 10);
  const end = String(counts.max_ts).slice(0, 10);
  const buckets = await completeBuckets(opts.tools, index, metric, opts.ontology.time.levels[0]);
  const seen = new Map<string, Promise<string[]>>();
  return {
    ontology: opts.ontology,
    today: opts.today ?? new Date().toISOString().slice(0, 10),
    as_of: opts.data.as_of,
    data: { start, end },
    labels: buckets.map((b) => ({ label: b.bucket, start: b.bucket_start.slice(0, 10), end: b.bucket_end.slice(0, 10) })),
    lookup: (kpi, concept) => {
      const key = `${kpi}/${concept}`;
      if (!seen.has(key)) {
        seen.set(
          key,
          opts.tools
            .call(index.slice(kpi, concept), { cur_start: String(counts.min_ts), cur_end: String(counts.max_ts), base_start: String(counts.min_ts), base_end: String(counts.max_ts) }, "intent")
            .then((rows) => rows.map((r) => String(r.node)).filter((v) => v !== "")),
        );
      }
      return seen.get(key)!;
    },
  };
}
