#!/usr/bin/env node
// Run the integration tests that need Python, DuckDB and the Toolbox binary.
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "core/mcp-server/dist/test/integration.test.js", "core/builder/dist/test/e2e.test.js"], {
  stdio: "inherit",
  env: { ...process.env, CAUSELINE_INTEGRATION: "1" },
});
process.exit(result.status ?? 1);
