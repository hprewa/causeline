import { existsSync } from "node:fs";
import { join } from "node:path";
import { withCostControl } from "@causeline/connect-bigquery";
import { causelineHome, findToolboxBinary, SdkToolCaller, ToolboxInstaller, ToolboxProcess, type ToolCaller } from "@causeline/runner";
import type { ServerConfig } from "./config.js";

/**
 * Owns the Toolbox this server talks to: starts one lazily (working directory
 * = the pack, so relative database paths resolve), restarts it if it died, and
 * stops it on shutdown. With CAUSELINE_TOOLBOX_URL set it uses that server instead.
 */
export class ToolboxManager {
  private process: ToolboxProcess | undefined;
  private starting: Promise<ToolboxProcess> | undefined;

  /** Fetches the data connection software the first time it is needed. */
  readonly installer: ToolboxInstaller;

  constructor(
    private readonly config: ServerConfig,
    installer?: ToolboxInstaller,
    /** How the program is looked for (the tests replace it). */
    private readonly locate: (explicit?: string) => string = findToolboxBinary,
  ) {
    this.installer = installer ?? new ToolboxInstaller({ home: config.home ?? causelineHome() });
  }

  /** The program to start: one already on the machine, else the fetched copy; when neither is there the download is started and the person is told. */
  private binary(): string {
    try {
      return this.locate(this.config.toolboxBinary);
    } catch {
      const r = this.installer.ensure();
      if ("path" in r) return r.path;
      throw new Error(r.notReady);
    }
  }

  private async url(): Promise<string> {
    if (this.config.toolboxUrl) return this.config.toolboxUrl;
    if (this.process?.running) return this.process.url;
    this.starting ??= ToolboxProcess.start({ cwd: this.config.packDir, configDir: "toolbox", binary: this.binary() }).finally(() => {
      this.starting = undefined;
    });
    this.process = await this.starting;
    return this.process.url;
  }

  /** A fresh caller each time: it loads the current toolset, so regenerated tools are picked up. */
  async caller(): Promise<ToolCaller> {
    const caller = new SdkToolCaller(await this.url());
    // a pack that reads a cloud database is metered: each query is priced before it runs and a budget stops a runaway
    return existsSync(join(this.config.packDir, "data.yaml")) ? withCostControl(this.config.packDir, caller) : caller;
  }

  async stop(): Promise<void> {
    await this.process?.stop();
    this.process = undefined;
  }

  /** The open project changed: the next call starts a Toolbox for the new one. */
  async reset(): Promise<void> {
    await this.stop();
  }
}
