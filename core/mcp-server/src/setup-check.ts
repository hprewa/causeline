import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { causelineHome, findToolboxBinary, ToolboxInstaller, VERSION } from "@causeline/runner";
import type { ServerConfig } from "./config.js";

export interface SetupLine {
  id: string;
  ok: boolean;
  /** One plain sentence for the person. */
  say: string;
  /** What to do, when it is not ok. */
  todo?: string;
}

export interface SetupReport {
  version: string;
  ready: boolean;
  /** One sentence for the person. */
  summary: string;
  checks: SetupLine[];
}

/**
 * Is everything in place to answer a question, in plain words, with what to do for anything that is not. Also starts fetching the data
 * connection software if it is missing, so the first check prepares the machine. Names only: no folder path is ever put in a line.
 */
export async function setupCheck(cfg: ServerConfig, installer: ToolboxInstaller, opts: { openProject?: string; signIn?: () => Promise<{ ok: boolean; summary: string }>; /** How the program is looked for (the tests replace it). */ locate?: (explicit?: string) => string } = {}): Promise<SetupReport> {
  const checks: SetupLine[] = [{ id: "version", ok: true, say: `Causeline ${VERSION}.` }];

  const home = cfg.home ?? causelineHome();
  try {
    mkdirSync(home, { recursive: true });
    const probe = join(home, ".write-test");
    writeFileSync(probe, "x");
    rmSync(probe, { force: true });
    checks.push({ id: "projects_folder", ok: true, say: "Your Causeline folder is there and can be written to." });
  } catch {
    checks.push({ id: "projects_folder", ok: false, say: "I cannot write to your Causeline folder, so nothing can be saved.", todo: "Choose a folder you can write to (in the extension's settings, or by setting CAUSELINE_HOME)." });
  }

  const status = installer.status();
  let found = false;
  try {
    (opts.locate ?? findToolboxBinary)(cfg.toolboxBinary);
    found = true;
  } catch {
    found = false;
  }
  if (cfg.toolboxUrl || found || status.state === "ready") {
    checks.push({ id: "data_connection", ok: true, say: "The data connection software is ready." });
  } else if (status.state === "unsupported") {
    checks.push({ id: "data_connection", ok: false, say: status.message, todo: "Someone technical needs to install it by hand for this computer." });
  } else {
    const r = installer.ensure();
    const message = "notReady" in r ? r.notReady : status.message;
    checks.push({ id: "data_connection", ok: false, say: message, todo: status.state === "failed" ? "Check the internet connection, then run this check again." : "Wait a few minutes, then run this check again." });
  }

  if (opts.signIn) {
    try {
      const r = await opts.signIn();
      checks.push({ id: "sign_in", ok: r.ok, say: r.summary, ...(r.ok ? {} : { todo: "Sign in to Google Cloud as the summary says, then run this check again." }) });
    } catch (e) {
      checks.push({ id: "sign_in", ok: false, say: `I could not check the sign-in: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` });
    }
  }
  checks.push({ id: "project", ok: true, say: opts.openProject ? `The project "${opts.openProject}" is open.` : "No project is open yet: ask me to start one, or to open one of yours." });

  const bad = checks.filter((c) => !c.ok);
  return { version: VERSION, ready: bad.length === 0, summary: bad.length === 0 ? "Everything is ready." : bad.map((c) => c.say).join(" "), checks };
}
