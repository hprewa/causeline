import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { parseToolRef } from "@causeline/schema";
import type { Row, ToolCaller } from "@causeline/runner";
import { openDb, rowsOf } from "../src/db.js";

interface Tool {
  parameters: { name: string; default?: unknown }[];
  statement: string;
}

/**
 * The generated query tools, run straight on the workspace's SQLite file (no Toolbox process), so tests of the
 * Builder's checks use the very statements the product sends. Parameters are bound in the order they are declared.
 */
export class SqliteTools implements ToolCaller {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly workspace: string) {
    const text = readFileSync(join(workspace, "toolbox", "tools.generated.yaml"), "utf-8");
    for (const doc of parseAllDocuments(text)) {
      const t = doc.toJS() as { name?: string; parameters?: Tool["parameters"]; statement?: string } | null;
      if (t?.name && t.statement) this.tools.set(t.name, { parameters: t.parameters ?? [], statement: t.statement });
    }
  }

  async call(tool: string, params: Record<string, string>, _stepId: string): Promise<Row[]> {
    const ref = parseToolRef(tool);
    const t = this.tools.get(ref.name);
    if (!t) throw new Error(`no such tool: ${ref.name}`);
    const all: Record<string, unknown> = { ...params, ...ref.bound };
    const values = t.parameters.map((p) => all[p.name] ?? p.default ?? "");
    const db = await openDb(join(this.workspace, "data", "causeline.db"));
    try {
      return rowsOf(db, t.statement, values);
    } finally {
      db.close();
    }
  }
}
