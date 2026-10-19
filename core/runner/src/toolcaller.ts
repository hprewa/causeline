import { parseToolRef, type StepLog } from "@causeline/schema";
import type { Row, ToolCaller } from "./types.js";

/** Wraps any ToolCaller so every call is logged with its name, params, row count and duration. */
export class LoggingToolCaller implements ToolCaller {
  readonly log: StepLog[] = [];
  constructor(private readonly inner: ToolCaller) {}

  async call(tool: string, params: Record<string, string>, stepId: string): Promise<Row[]> {
    const started = Date.now();
    const rows = await this.inner.call(tool, params, stepId);
    this.log.push({ id: stepId, tool, params, rows: rows.length, ms: Date.now() - started });
    return rows;
  }
}

/** Parse a Toolbox tool result: a JSON array string, a lone object, or null/empty for no rows. */
export function parseToolResult(tool: string, raw: unknown): Row[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string") throw new Error(`tool ${tool} returned ${typeof raw}, expected a JSON string`);
  const text = raw.trim();
  if (text === "" || text === "null") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Toolbox reports tool errors as plain text rather than throwing.
    throw new Error(`tool ${tool} failed: ${text.slice(0, 300)}`);
  }
  // Toolbox returns a bare object for a single row and an array for several.
  if (Array.isArray(parsed)) return parsed as Row[];
  if (parsed !== null && typeof parsed === "object") return [parsed as Row];
  throw new Error(`tool ${tool} returned an unexpected result: ${text.slice(0, 200)}`);
}

type LoadedTool = ((args?: Record<string, unknown>) => Promise<string>) & { toolName: string };

/** ToolCaller backed by a running MCP Toolbox server through @toolbox-sdk/core. */
export class SdkToolCaller implements ToolCaller {
  private tools = new Map<string, LoadedTool>();
  private loaded = false;

  constructor(
    private readonly url = "http://127.0.0.1:5000",
    private readonly toolset = "causeline",
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const { ToolboxClient } = await import("@toolbox-sdk/core");
    const client = new ToolboxClient(this.url);
    let loaded: LoadedTool[];
    try {
      loaded = (await client.loadToolset(this.toolset)) as unknown as LoadedTool[];
    } catch (e) {
      throw new Error(`could not load toolset "${this.toolset}" from Toolbox at ${this.url}: ${(e as Error).message}. Is the server running (npm run toolbox) and tools generated (causeline generate)?`);
    }
    for (const t of loaded) this.tools.set(t.toolName, t);
    this.loaded = true;
  }

  async call(tool: string, params: Record<string, string>): Promise<Row[]> {
    await this.load();
    // a tool reference carries values that are always sent with the call (a series tool's time level)
    const { name, bound } = parseToolRef(tool);
    const fn = this.tools.get(name);
    if (!fn) throw new Error(`tool "${name}" is not in toolset "${this.toolset}"; rerun causeline generate`);
    return parseToolResult(name, await fn({ ...bound, ...params }));
  }
}
