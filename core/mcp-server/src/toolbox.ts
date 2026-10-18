import { SdkToolCaller, ToolboxProcess, type ToolCaller } from "@causeline/runner";
import type { ServerConfig } from "./config.js";

/**
 * Owns the Toolbox this server talks to: starts one lazily (working directory
 * = the pack, so relative database paths resolve), restarts it if it died, and
 * stops it on shutdown. With CAUSELINE_TOOLBOX_URL set it uses that server instead.
 */
export class ToolboxManager {
  private process: ToolboxProcess | undefined;
  private starting: Promise<ToolboxProcess> | undefined;

  constructor(private readonly config: ServerConfig) {}

  private async url(): Promise<string> {
    if (this.config.toolboxUrl) return this.config.toolboxUrl;
    if (this.process?.running) return this.process.url;
    this.starting ??= ToolboxProcess.start({ cwd: this.config.packDir, configDir: "toolbox", binary: this.config.toolboxBinary }).finally(() => {
      this.starting = undefined;
    });
    this.process = await this.starting;
    return this.process.url;
  }

  /** A fresh caller each time: it loads the current toolset, so regenerated tools are picked up. */
  async caller(): Promise<ToolCaller> {
    return new SdkToolCaller(await this.url());
  }

  async stop(): Promise<void> {
    await this.process?.stop();
    this.process = undefined;
  }
}
