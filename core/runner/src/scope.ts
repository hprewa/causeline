import { parseToolRef, type Cost, type ToolsMeta } from "@causeline/schema";
import type { Row, ToolCaller } from "./types.js";

/** Read a run's `scope` input: a JSON object of concept -> value. Empty means the whole data. */
export function parseScope(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error(`scope must be a JSON object of concept to value (got ${String(raw).slice(0, 80)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("scope must be a JSON object of concept to value");
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
}

/**
 * Confines every query that can be confined to one value of one or more concepts ("only this one"). The tools
 * already take each concept as an optional filter, so a series or a slice by another concept just gets the
 * values; a slice *by* a scoped concept keeps only that value's row. Tools that are not about the metric's rows
 * (the extent, checks, records that explain a finding) pass through. A tool that cannot be confined to a scoped
 * concept is an error, never a silently wider answer.
 */
export class ScopedToolCaller implements ToolCaller {
  constructor(
    private readonly inner: ToolCaller,
    private readonly meta: ToolsMeta,
    readonly scope: Record<string, string>,
  ) {}

  async call(tool: string, params: Record<string, string>, stepId: string): Promise<Row[]> {
    const m = this.meta.tools[parseToolRef(tool).name];
    if (!m || (m.kind !== "slice" && m.kind !== "series") || Object.keys(this.scope).length === 0) return this.inner.call(tool, params, stepId);
    const next = { ...params };
    const keep: [string, string][] = [];
    for (const [concept, value] of Object.entries(this.scope)) {
      if (m.kind === "slice" && m.by === concept) keep.push([concept, value]);
      else if (m.filters.includes(concept)) {
        // a drill already narrowed this concept: the narrower, explicit value stands
        if (next[concept] === undefined || next[concept] === "") next[concept] = value;
        else if (next[concept] !== value) return [];
      } else throw new Error(`cannot confine "${parseToolRef(tool).name}" to ${concept} ${value}: the tool has no such filter; run \`causeline generate\` for the pack`);
    }
    const rows = await this.inner.call(tool, next, stepId);
    return keep.length === 0 ? rows : rows.filter((r) => keep.every(([, v]) => String(r.node) === v));
  }

  cost(): Cost | undefined {
    return this.inner.cost?.();
  }
}
