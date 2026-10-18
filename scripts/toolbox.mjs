#!/usr/bin/env node
// Run Toolbox for a pack in the foreground, the way causeline-mcp and the eval runner
// do: working directory = the pack, config folder = <pack>/toolbox.
//   node scripts/toolbox.mjs [pack dir] [port]
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { findToolboxBinary } from "../core/runner/dist/src/toolbox-process.js";

const pack = resolve(process.argv[2] ?? "packs/contact-centre");
const port = process.argv[3] ?? "5000";
const child = spawn(findToolboxBinary(), ["--config-folder", "toolbox", "--port", port], { cwd: pack, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill());
