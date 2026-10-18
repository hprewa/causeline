#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { ToolboxManager } from "./toolbox.js";

// stdout carries the MCP protocol, so anything human-readable goes to stderr
const config = loadConfig();
const toolbox = new ToolboxManager(config);
const server = createServer(config, toolbox);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await toolbox.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
console.error(`causeline-mcp serving ${config.packDir}`);
