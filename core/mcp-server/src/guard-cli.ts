import { decision } from "./guard.js";

/** Read a shell-command hook call from stdin and answer on stdout: deny it if it is a side door to the data, else nothing. */
export function runGuard(): Promise<void> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let input: unknown = {};
      try {
        input = JSON.parse(raw || "{}");
      } catch {
        // not something we can read: do not get in the way
      }
      process.stdout.write(JSON.stringify(decision(input as never)) + "\n");
      resolve();
    });
  });
}

// run as a program (the plugin's hook is this file, bundled)
if (process.argv[1] && /guard\.mjs$|guard-cli\.js$/.test(process.argv[1])) void runGuard();
