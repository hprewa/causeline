import { BUILDS, causelineHome, installDir, platformKey } from "./toolbox-install.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ToolboxOptions {
  /** Working directory: relative paths in the Toolbox source resolve against it. */
  cwd: string;
  /** Folder of Toolbox YAML (source, tools). Toolbox hot-reloads it. */
  configDir: string;
  /** Path to the toolbox binary; otherwise found by findToolboxBinary. */
  binary?: string;
  port?: number;
  /** Give up waiting for readiness after this many ms. */
  startupTimeoutMs?: number;
}

const exeName = process.platform === "win32" ? "toolbox.exe" : "toolbox";

/**
 * Locate the Toolbox binary: an explicit path, then CAUSELINE_TOOLBOX, then PATH, then the copy fetched into the Causeline home on first use,
 * then a toolbox binary at the repo root (where the README installs it).
 */
export function findToolboxBinary(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (env.CAUSELINE_TOOLBOX) candidates.push(env.CAUSELINE_TOOLBOX);
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, exeName));
  const build = BUILDS[platformKey()];
  if (build) candidates.push(join(installDir(causelineHome(env)), build.file));
  candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", exeName));
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(`could not find the Toolbox binary (${exeName}); set CAUSELINE_TOOLBOX or put it on PATH. Looked at: ${candidates.slice(0, 4).join(", ")}${candidates.length > 4 ? ", ..." : ""}`);
  }
  return found;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => res(port));
    });
  });
}

/** A Toolbox HTTP server this process started, and is responsible for stopping. */
export class ToolboxProcess {
  private constructor(
    private readonly child: ChildProcess,
    readonly url: string,
    private readonly onExit: () => void,
  ) {}

  static async start(opts: ToolboxOptions): Promise<ToolboxProcess> {
    const binary = findToolboxBinary(opts.binary);
    const port = opts.port ?? (await freePort());
    const child = spawn(binary, ["--config-folder", opts.configDir, "--port", String(port), "--address", "127.0.0.1"], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // Never leave an orphaned server behind if this process exits first.
    const onExit = () => child.kill();
    process.once("exit", onExit);
    const instance = new ToolboxProcess(child, `http://127.0.0.1:${port}`, onExit);

    let output = "";
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Toolbox did not become ready within ${opts.startupTimeoutMs ?? 30000} ms. Output:\n${output.slice(-1500)}`));
      }, opts.startupTimeoutMs ?? 30000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Server ready to serve")) {
          clearTimeout(timer);
          resolveReady();
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Toolbox exited with code ${code} before it was ready. Output:\n${output.slice(-1500)}`));
      });
    });
    // after readiness, stop reading the pipes so they cannot fill and stall the server
    child.stdout!.removeAllListeners("data");
    child.stderr!.removeAllListeners("data");
    child.stdout!.resume();
    child.stderr!.resume();
    child.removeAllListeners("exit");
    return instance;
  }

  /** False once the server has exited or been stopped. */
  get running(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  async stop(): Promise<void> {
    process.removeListener("exit", this.onExit);
    if (this.child.exitCode !== null || this.child.killed) return;
    await new Promise<void>((res) => {
      this.child.once("exit", () => res());
      this.child.kill();
      setTimeout(res, 3000).unref();
    });
  }
}
