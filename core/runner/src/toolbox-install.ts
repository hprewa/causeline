import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The data connection software (MCP Toolbox) is fetched the first time it is needed instead of being installed by hand: it is 156 to 316 MB
 * a platform, too big to ship inside an extension. The file is checked against a SHA-256 pinned here before it is ever run; nothing waits
 * for the download (a tool call that blocked for minutes would be given up on by the client), so the first use starts it in the background and
 * says in plain words how far along it is.
 */

/** Where the Causeline home is: CAUSELINE_HOME, else a Causeline folder in the person's home. Projects, and the software fetched here, live under it. */
export function causelineHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.CAUSELINE_HOME?.trim();
  return resolve(set ? set : join(homedir(), "Causeline"));
}

export const TOOLBOX_VERSION = "1.14.0";

export interface ToolboxBuild {
  /** `<platform>-<arch>` as Node names them. */
  key: string;
  url: string;
  size: number;
  sha256: string;
  /** The file's name once installed. */
  file: string;
}

const BASE = `https://storage.googleapis.com/mcp-toolbox-for-databases/v${TOOLBOX_VERSION}`;

/** Every build that exists for the pinned version. There is none for Linux on ARM. */
export const BUILDS: Record<string, ToolboxBuild> = {
  "win32-x64": { key: "win32-x64", url: `${BASE}/windows/amd64/toolbox.exe`, size: 294395032, sha256: "0426c65989a2cc6a4fbe3caf1145378db5b32a8dd584fc2e0e3d8e93cdc04270", file: "toolbox.exe" },
  "darwin-arm64": { key: "darwin-arm64", url: `${BASE}/darwin/arm64/toolbox`, size: 155804288, sha256: "d1578b3f551b1aa0947c7b377716cd5e8b9448ac5a79fdc1e06dc11a69bbe334", file: "toolbox" },
  "darwin-x64": { key: "darwin-x64", url: `${BASE}/darwin/amd64/toolbox`, size: 167366656, sha256: "79db60dfd3e4c50c7019d4d0a15069b405392375067c0cfed1b6b1fdf0b0e458", file: "toolbox" },
  "linux-x64": { key: "linux-x64", url: `${BASE}/linux/amd64/toolbox`, size: 315661608, sha256: "8ff7c6034d792e2754999e101116ac63b8a9fb926dd2f736065d8e0ef85ead22", file: "toolbox" },
};

export const platformKey = (platform: string = process.platform, arch: string = process.arch): string => `${platform}-${arch}`;

export const installDir = (home: string): string => join(home, "bin", `toolbox-${TOOLBOX_VERSION}`);

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

export interface InstallStatus {
  /** `ready`: present and checked. `downloading`: under way (here or in another process). `failed`: the last try did not work (a new try starts on the next use). `unsupported`: no build for this machine. `idle`: not present, not started. */
  state: "ready" | "downloading" | "failed" | "unsupported" | "idle";
  bytes: number;
  total: number;
  /** What to tell the person, in plain words. */
  message: string;
}

export interface InstallerOptions {
  home: string;
  builds?: Record<string, ToolboxBuild>;
  platform?: string;
  arch?: string;
  /** How far in the past a progress note may be and still mean "another process is downloading". */
  staleMs?: number;
  fetchImpl?: typeof fetch;
}

interface Progress {
  pid: number;
  bytes: number;
  total: number;
  at: number;
}

/** Fetches, checks and keeps the Toolbox for this machine. */
export class ToolboxInstaller {
  private readonly builds: Record<string, ToolboxBuild>;
  private readonly platform: string;
  private readonly arch: string;
  private readonly stale: number;
  private running: Promise<string> | undefined;
  private bytes = 0;
  private failure: string | undefined;

  constructor(private readonly o: InstallerOptions) {
    this.builds = o.builds ?? BUILDS;
    this.platform = o.platform ?? process.platform;
    this.arch = o.arch ?? process.arch;
    this.stale = o.staleMs ?? 20_000;
  }

  private get build(): ToolboxBuild | undefined {
    return this.builds[platformKey(this.platform, this.arch)];
  }

  private get dir(): string {
    return installDir(this.o.home);
  }

  private get progressFile(): string {
    return join(this.dir, "download.progress.json");
  }

  /** The installed, checked file, or null. */
  find(): string | null {
    const b = this.build;
    if (!b) return null;
    const path = join(this.dir, b.file);
    return existsSync(path) && statSync(path).size === b.size ? path : null;
  }

  private otherProcess(): Progress | null {
    try {
      const p = JSON.parse(readFileSync(this.progressFile, "utf-8")) as Progress;
      return p.pid !== process.pid && Date.now() - p.at < this.stale ? p : null;
    } catch {
      return null;
    }
  }

  status(): InstallStatus {
    const b = this.build;
    if (!b) return { state: "unsupported", bytes: 0, total: 0, message: this.unsupportedMessage() };
    if (this.find()) return { state: "ready", bytes: b.size, total: b.size, message: "The data connection software is ready." };
    if (this.running) return { state: "downloading", bytes: this.bytes, total: b.size, message: this.progressMessage(this.bytes, b.size) };
    const other = this.otherProcess();
    if (other) return { state: "downloading", bytes: other.bytes, total: b.size, message: this.progressMessage(other.bytes, b.size) };
    if (this.failure) return { state: "failed", bytes: 0, total: b.size, message: this.failure };
    return { state: "idle", bytes: 0, total: b.size, message: `The data connection software (about ${mb(b.size)}) has not been fetched yet; it is fetched the first time it is needed.` };
  }

  private progressMessage(bytes: number, total: number): string {
    const pct = total > 0 ? Math.min(99, Math.floor((bytes / total) * 100)) : 0;
    return `I am preparing the data connection for the first time (about ${mb(total)}, ${pct}% done). This takes a few minutes; ask again shortly.`;
  }

  private unsupportedMessage(): string {
    return `There is no ready-made data connection for this computer (${this.platform}, ${this.arch}). Someone technical can install Toolbox ${TOOLBOX_VERSION} for it by hand and set CAUSELINE_TOOLBOX to its location.`;
  }

  /**
   * Make sure the software is there. Never waits: returns the path when it is present, otherwise starts the download (once) and returns
   * what to tell the person. A failed earlier try is tried again.
   */
  ensure(): { path: string } | { notReady: string } {
    const b = this.build;
    if (!b) return { notReady: this.unsupportedMessage() };
    const found = this.find();
    if (found) return { path: found };
    if (this.running) return { notReady: this.progressMessage(this.bytes, b.size) };
    const other = this.otherProcess();
    if (other) return { notReady: this.progressMessage(other.bytes, b.size) };
    this.failure = undefined;
    this.start().catch(() => undefined);
    return { notReady: this.progressMessage(0, b.size) };
  }

  /** Download, check and install; resolves with the path. Starts at most one download in this process. */
  start(): Promise<string> {
    this.running ??= this.download().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async download(): Promise<string> {
    const b = this.build;
    if (!b) throw new Error(this.unsupportedMessage());
    const target = join(this.dir, b.file);
    const part = `${target}.part`;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      this.failure = `I could not make a place to keep the data connection software (${mb(b.size)}) in your Causeline folder. Check that the folder can be written to, or set CAUSELINE_HOME to one that can.`;
      throw new Error(this.failure);
    }
    const note = (bytes: number) => {
      this.bytes = bytes;
      try {
        writeFileSync(this.progressFile, JSON.stringify({ pid: process.pid, bytes, total: b.size, at: Date.now() } satisfies Progress));
      } catch {
        // progress is a courtesy
      }
    };
    try {
      const have = existsSync(part) ? statSync(part).size : 0;
      note(have);
      const doFetch = this.o.fetchImpl ?? fetch;
      let res = await doFetch(b.url, { headers: have > 0 && have < b.size ? { Range: `bytes=${have}-` } : {} });
      let append = res.status === 206;
      if (res.status === 416 || (have >= b.size && res.status !== 206)) {
        rmSync(part, { force: true });
        res = await doFetch(b.url);
        append = false;
      }
      if (!res.ok || !res.body) throw new Error(`the download server answered ${res.status}`);
      if (!append) rmSync(part, { force: true });
      const out = createWriteStream(part, { flags: append ? "a" : "w" });
      let bytes = append ? have : 0;
      let last = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", r));
        bytes += value.length;
        if (Date.now() - last > 1000) {
          last = Date.now();
          note(bytes);
        }
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
      note(bytes);
      if (statSync(part).size !== b.size) throw new Wrong(`the file that came down is ${mb(statSync(part).size)}, not the ${mb(b.size)} expected`);
      const sum = await sha256Of(part);
      if (sum !== b.sha256) throw new Wrong("the file that came down is not the one expected (its fingerprint does not match), so it was not used");
      if (process.platform !== "win32") chmodSync(part, 0o755);
      renameSync(part, target);
      rmSync(this.progressFile, { force: true });
      this.failure = undefined;
      return target;
    } catch (e) {
      const wrong = e instanceof Wrong;
      if (wrong) rmSync(part, { force: true });
      rmSync(this.progressFile, { force: true });
      this.bytes = 0;
      const why = e instanceof Error ? e.message : String(e);
      this.failure = wrong
        ? `The data connection software did not download correctly: ${why}. Ask again to try once more; if it keeps failing, someone technical can fetch it by hand and set CAUSELINE_TOOLBOX.`
        : `I could not fetch the data connection software (${why}). Check the internet connection (a company network may block storage.googleapis.com; IT can allow it), then ask again; or someone technical can install it by hand and set CAUSELINE_TOOLBOX.`;
      throw new Error(this.failure);
    }
  }
}

class Wrong extends Error {}

/** SHA-256 of a file, streamed (the file may be hundreds of megabytes). */
export function sha256Of(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", rej)
      .on("end", () => res(h.digest("hex")));
  });
}
