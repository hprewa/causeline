import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The guidance a model needs for each kind of request, delivered by the server itself. In Claude Code this is also a skill; a Claude Desktop
 * extension and a Codex server cannot carry skills, so the same text comes through the `get_guide` tool and as resources. The text is the
 * skills' own (`skills/<name>/SKILL.md`): one source, embedded in the bundle at build time (`__CAUSELINE_GUIDES__`), or read from the
 * skills folder when running from the source.
 */

export const GUIDE_NAMES = ["build", "investigate", "explore", "onboard"] as const;
export type GuideName = (typeof GUIDE_NAMES)[number];

export interface Guide {
  name: GuideName;
  /** When to use it, in one sentence. */
  when: string;
  /** The guidance, without the front matter. */
  text: string;
}

declare const __CAUSELINE_GUIDES__: Record<string, string> | undefined;

const skillFolder = (name: GuideName) => `causeline-${name}`;

/** Split a skill file into its front matter fields and its body. */
export function parseSkill(raw: string): { description: string; when_to_use: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { description: "", when_to_use: "", body: raw };
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1])?.[1].trim() ?? "";
  return { description: field("description"), when_to_use: field("when_to_use"), body: m[2].replace(/^\s+/, "") };
}

function skillsDir(env: NodeJS.ProcessEnv): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [env.CAUSELINE_SKILLS, resolve(here, "..", "skills"), resolve(here, "..", "..", "skills"), resolve(here, "..", "..", "..", "..", "skills")].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(join(c, "causeline-build", "SKILL.md"))) ?? null;
}

/** The raw text of every skill: embedded in a bundle, else read from the skills folder. */
export function loadSkills(env: NodeJS.ProcessEnv = process.env): Record<GuideName, string> {
  const embedded = typeof __CAUSELINE_GUIDES__ !== "undefined" ? __CAUSELINE_GUIDES__ : undefined;
  const dir = embedded ? null : skillsDir(env);
  if (!embedded && !dir) throw new Error("the guides are not available: the skills folder was not found (set CAUSELINE_SKILLS to it)");
  return Object.fromEntries(GUIDE_NAMES.map((n) => [n, embedded ? (embedded[skillFolder(n)] ?? "") : readFileSync(join(dir!, skillFolder(n), "SKILL.md"), "utf-8")])) as Record<GuideName, string>;
}

export function loadGuides(env: NodeJS.ProcessEnv = process.env): Guide[] {
  const skills = loadSkills(env);
  return GUIDE_NAMES.map((name) => {
    const s = parseSkill(skills[name]);
    return { name, when: s.description || s.when_to_use, text: s.body };
  });
}

/** What `get_guide` answers: the list when no name is given, else the named guide. */
export function getGuide(name: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  const guides = loadGuides(env);
  if (!name) return { guides: guides.map((g) => ({ name: g.name, when: g.when })), next: "Call get_guide with the name that fits the user's request, then follow it." };
  const g = guides.find((x) => x.name === name);
  if (!g) throw new Error(`there is no guide called "${name}". The guides are: ${GUIDE_NAMES.join(", ")}.`);
  return { guide: g.name, when: g.when, text: g.text };
}
