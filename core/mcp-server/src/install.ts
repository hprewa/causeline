import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { INSTRUCTIONS } from "./instructions.js";
import { GUIDE_NAMES, loadSkills } from "./guides.js";

/**
 * Put Causeline into Codex, safely. Codex has no Node for an MCP server and no way to carry skills inside one, so this writes what it
 * needs into the person's own Codex files: the server entry (`config.toml`), the instructions (`AGENTS.md`), the guidance as skills
 * (`~/.agents/skills`) and the guard for shell commands (`hooks.json`). Everything it writes is between markers or in a folder it marks as its
 * own; a file is backed up before its first change; running it again changes nothing; `uninstall` removes exactly what was added.
 */

export interface LaunchCommand {
  command: string;
  args: string[];
}

export interface InstallPaths {
  /** Codex's folder (`CODEX_HOME`, else `~/.codex`). */
  codex: string;
  /** Where Codex looks for a person's own skills (`~/.agents/skills`). */
  skills: string;
}

export function codexPaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): InstallPaths {
  return { codex: env.CODEX_HOME?.trim() || join(home, ".codex"), skills: join(home, ".agents", "skills") };
}

const TOML_BEGIN = "# >>> causeline (written by `causeline-mcp install codex`; `uninstall codex` removes it) >>>";
const TOML_END = "# <<< causeline <<<";
const MD_BEGIN = "<!-- causeline:begin (written by `causeline-mcp install codex`; `uninstall codex` removes it) -->";
const MD_END = "<!-- causeline:end -->";
const HOOK_NOTE = "Causeline: keeping data reads to its tools";
const SKILL_MARK = ".causeline-managed";

/** A TOML literal string: no escapes, so a Windows path is written as it is. */
const lit = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
const quoteCmd = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

export function tomlBlock(launch: LaunchCommand, env: Record<string, string>): string {
  const lines = [TOML_BEGIN, "[mcp_servers.causeline]", `command = ${lit(launch.command)}`, `args = [${launch.args.map(lit).join(", ")}]`, "startup_timeout_sec = 60", "tool_timeout_sec = 300"];
  if (Object.keys(env).length > 0) {
    lines.push("", "[mcp_servers.causeline.env]", ...Object.entries(env).map(([k, v]) => `${k} = ${lit(v)}`));
  }
  lines.push(TOML_END);
  return lines.join("\n") + "\n";
}

const between = (text: string, begin: string, end: string): { from: number; to: number } | null => {
  const a = text.indexOf(begin);
  if (a < 0) return null;
  const b = text.indexOf(end, a);
  if (b < 0) throw new Error("a Causeline block in this file has no end marker, so it was left alone; fix or remove it by hand");
  return { from: a, to: b + end.length + (text[b + end.length] === "\n" ? 1 : 0) };
};

/** Replace the marked block (or append it), leaving every other byte as it was. */
function withBlock(text: string, begin: string, end: string, block: string): string {
  const at = between(text, begin, end);
  if (at) return text.slice(0, at.from) + block + text.slice(at.to);
  return text + (text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n") + block;
}

function withoutBlock(text: string, begin: string, end: string): string {
  const at = between(text, begin, end);
  if (!at) return text;
  const rest = text.slice(0, at.from).replace(/\n+$/, text.slice(at.to) === "" ? "\n" : "\n\n") + text.slice(at.to);
  return rest.trim() === "" ? "" : rest;
}

export interface Report {
  /** What was changed, in plain words. */
  changed: string[];
  /** Files copied aside before their first change. */
  backups: string[];
  /** Said to the person after the change. */
  next: string[];
}

class Writer {
  readonly changed: string[] = [];
  readonly backups: string[] = [];
  constructor(private readonly stamp: string) {}

  /** Write `next` to `file` if it differs from what is there; back the file up first when it exists. An empty result removes the file. */
  put(file: string, next: string, what: string): void {
    const had = existsSync(file);
    const before = had ? readFileSync(file, "utf-8") : null;
    if (before === next || (before === null && next === "")) return;
    if (had) {
      const backup = `${file}.causeline-backup-${this.stamp}`;
      if (!existsSync(backup)) copyFileSync(file, backup);
      this.backups.push(backup);
    }
    if (next === "") rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, next, "utf-8");
    }
    this.changed.push(what);
  }
}

const stampOf = (now: Date) => now.toISOString().replace(/[-:T]/g, "").slice(0, 14);

export interface InstallOptions {
  paths: InstallPaths;
  launch: LaunchCommand;
  /** Environment the server should start with (for example CAUSELINE_HOME when it is not the default). */
  env?: Record<string, string>;
  now?: Date;
}

/** The hook's command: this program, asked to guard a shell command. */
const hookCommand = (l: LaunchCommand) => [l.command, ...l.args, "guard"].map(quoteCmd).join(" ");

export function installCodex(o: InstallOptions): Report {
  const w = new Writer(stampOf(o.now ?? new Date()));
  const config = join(o.paths.codex, "config.toml");
  const current = existsSync(config) ? readFileSync(config, "utf-8") : "";
  const outside = between(current, TOML_BEGIN, TOML_END) ? current.slice(0, between(current, TOML_BEGIN, TOML_END)!.from) + current.slice(between(current, TOML_BEGIN, TOML_END)!.to) : current;
  if (/^\s*\[mcp_servers\.causeline[\].]/m.test(outside)) throw new Error("your Codex settings already have a server called causeline that this did not add; nothing was changed. Remove it (or rename it) and run this again.");
  w.put(config, withBlock(current, TOML_BEGIN, TOML_END, tomlBlock(o.launch, o.env ?? {})), "added Causeline to your Codex settings");

  const agents = join(o.paths.codex, "AGENTS.md");
  const text = existsSync(agents) ? readFileSync(agents, "utf-8") : "";
  w.put(agents, withBlock(text, MD_BEGIN, MD_END, `${MD_BEGIN}\n## Causeline\n\n${INSTRUCTIONS}\n${MD_END}\n`), "added Causeline's instructions to your Codex instructions");

  const skills = loadSkills();
  for (const name of GUIDE_NAMES) {
    const dir = join(o.paths.skills, `causeline-${name}`);
    const file = join(dir, "SKILL.md");
    if (existsSync(dir) && !existsSync(join(dir, SKILL_MARK))) throw new Error(`a skill folder called causeline-${name} is already in your skills and is not Causeline's own; nothing more was changed`);
    if (!existsSync(file) || readFileSync(file, "utf-8") !== skills[name]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SKILL_MARK), "written by causeline-mcp install codex\n", "utf-8");
      writeFileSync(file, skills[name], "utf-8");
      w.changed.push(`added the causeline-${name} skill`);
    }
  }

  const hooks = join(o.paths.codex, "hooks.json");
  let doc: { hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string; statusMessage?: string }[] }[]> } = {};
  if (existsSync(hooks)) {
    try {
      doc = JSON.parse(readFileSync(hooks, "utf-8"));
    } catch {
      throw new Error("your Codex hooks file is not valid JSON, so it was left alone; the rest was installed");
    }
  }
  const groups = ((doc.hooks ??= {}).PreToolUse ??= []);
  const mine = (g: (typeof groups)[number]) => (g.hooks ?? []).some((h) => h.statusMessage === HOOK_NOTE);
  const wanted = { matcher: "Bash", hooks: [{ type: "command", command: hookCommand(o.launch), statusMessage: HOOK_NOTE, timeout: 30 }] };
  const existing = groups.find(mine);
  if (existing) Object.assign(existing, wanted);
  else groups.push(wanted);
  w.put(hooks, JSON.stringify(doc, null, 2) + "\n", "added the guard for shell commands to your Codex hooks");

  return {
    changed: w.changed,
    backups: [...new Set(w.backups)],
    next: w.changed.length === 0 ? ["Causeline was already set up for Codex; nothing changed."] : ["Restart Codex so it picks this up.", "Codex asks you to review the new hook the first time: type /hooks and trust the Causeline one.", "Then say: \"open my Causeline project\" or \"start a new project\"."],
  };
}

export function uninstallCodex(o: { paths: InstallPaths; now?: Date }): Report {
  const w = new Writer(stampOf(o.now ?? new Date()));
  const config = join(o.paths.codex, "config.toml");
  if (existsSync(config)) w.put(config, withoutBlock(readFileSync(config, "utf-8"), TOML_BEGIN, TOML_END), "removed Causeline from your Codex settings");
  const agents = join(o.paths.codex, "AGENTS.md");
  if (existsSync(agents)) w.put(agents, withoutBlock(readFileSync(agents, "utf-8"), MD_BEGIN, MD_END), "removed Causeline's instructions from your Codex instructions");
  if (existsSync(o.paths.skills)) {
    for (const d of readdirSync(o.paths.skills)) {
      if (/^causeline-/.test(d) && existsSync(join(o.paths.skills, d, SKILL_MARK))) {
        rmSync(join(o.paths.skills, d), { recursive: true, force: true });
        w.changed.push(`removed the ${d} skill`);
      }
    }
  }
  const hooks = join(o.paths.codex, "hooks.json");
  if (existsSync(hooks)) {
    let doc: { hooks?: Record<string, { hooks?: { statusMessage?: string }[] }[]> };
    try {
      doc = JSON.parse(readFileSync(hooks, "utf-8"));
    } catch {
      doc = {};
    }
    const groups = doc.hooks?.PreToolUse;
    if (groups) {
      const kept = groups.filter((g) => !(g.hooks ?? []).some((h) => h.statusMessage === HOOK_NOTE));
      if (kept.length !== groups.length) {
        doc.hooks!.PreToolUse = kept;
        if (kept.length === 0) delete doc.hooks!.PreToolUse;
        if (Object.keys(doc.hooks!).length === 0) delete doc.hooks;
        w.put(hooks, Object.keys(doc).length === 0 ? "" : JSON.stringify(doc, null, 2) + "\n", "removed the guard for shell commands from your Codex hooks");
      }
    }
  }
  return { changed: w.changed, backups: [...new Set(w.backups)], next: w.changed.length === 0 ? ["Causeline was not set up for Codex; nothing changed."] : ["Restart Codex. Your Causeline projects were not touched."] };
}
