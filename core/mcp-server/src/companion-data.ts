import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FACTS, stepWords } from "@causeline/runner";
import { Exploration, Result, type Playbook, type Target } from "@causeline/schema";
import type { ExplorationItem, PlaybookView, ResultItem } from "./companion-pages.js";

const label = (p: Playbook, id: string) => {
  const s = p.steps.find((x) => x.id === id);
  return s ? stepWords(s.evidence ? "evidence" : s.compute!, s.over) : id;
};

function target(p: Playbook, t: Target): string {
  if (typeof t === "string") return `go to "${label(p, t)}"`;
  if ("stop" in t) return `stop the run (${t.stop.replace(/_/g, " ")})`;
  return `hand over to ${t.handoff.replace(/_/g, " ")}`;
}

/** A playbook as the page shows it: each step in words, what it records, and the rules that choose what follows. */
export function playbookView(p: Playbook, source: "pack" | "core"): PlaybookView {
  return {
    name: p.name,
    description: p.description,
    source,
    steps: p.steps.map((s) => {
      const compute = s.evidence ? "evidence" : s.compute!;
      return {
        id: s.id,
        label: stepWords(compute, s.over),
        ...(s.when ? { when: s.when } : {}),
        facts: (FACTS[compute] ?? []).map((f) => `${s.id}.${f}`),
        rules: (s.next ?? []).map((r) => ({ text: r.if !== undefined ? `if ${r.if}: ${target(p, r.then!)}` : `otherwise: ${target(p, r.else!)}` })),
        ...(s.max_visits ? { max_visits: s.max_visits } : {}),
      };
    }),
  };
}

const FILE_NAME = /^[A-Za-z0-9._-]+\.json$/;
const EXPLORATION_FILE = /^exploration-[A-Za-z0-9._-]+\.json$/;

/** The latest answers kept for the project (newest first). Reads only what the run itself wrote. */
export function listResults(runsDir: string, limit = 40): ResultItem[] {
  if (!runsDir || !existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((f) => FILE_NAME.test(f))
    .map((f) => ({ f, at: statSync(join(runsDir, f)).mtime.toISOString() }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.f.localeCompare(a.f)) // file names begin with the time, so a tie in time is settled by the name
    .slice(0, limit)
    .flatMap(({ f, at }) => {
      try {
        const r = Result.parse(JSON.parse(readFileSync(join(runsDir, f), "utf-8")));
        const top = r.findings[0];
        const summary = r.status === "stopped" ? (r.stopped_reason ?? "stopped").replace(/_/g, " ") : top ? `${top.dimension.replace(/_/g, " ")} ${top.value}` : "nothing stood out";
        const period = String(r.inputs.period || (r.inputs.start_date ? `${r.inputs.start_date} to ${r.inputs.end_date}` : ""));
        return [{ file: f, at, metric: String(r.inputs.metric ?? r.headline?.metric ?? ""), period, playbook: r.playbook, status: r.status, summary }];
      } catch {
        return []; // not a result of this version: not listed
      }
    });
}

/** One kept answer, by the name it was listed under (only a plain file name inside the results folder is ever read). */
export function readResult(runsDir: string, file: string): Result | null {
  if (!FILE_NAME.test(file) || !runsDir || !existsSync(join(runsDir, file))) return null;
  try {
    return Result.parse(JSON.parse(readFileSync(join(runsDir, file), "utf-8")));
  } catch {
    return null;
  }
}

/** The explorations kept for the project (newest first). */
export function listExplorations(runsDir: string, limit = 40): ExplorationItem[] {
  if (!runsDir || !existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((f) => EXPLORATION_FILE.test(f))
    .map((f) => ({ f, at: statSync(join(runsDir, f)).mtime.toISOString() }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.f.localeCompare(a.f))
    .slice(0, limit)
    .flatMap(({ f, at }) => {
      try {
        const e = Exploration.parse(JSON.parse(readFileSync(join(runsDir, f), "utf-8")));
        return [{ file: f, at, question: e.question, steps: e.steps.length, refused: e.steps.filter((s) => s.refusal).length, stopped: !!e.stopped }];
      } catch {
        return [];
      }
    });
}

/** One kept exploration, by the name it was listed under (a plain exploration file name inside the results folder only). */
export function readExploration(runsDir: string, file: string): Exploration | null {
  if (!EXPLORATION_FILE.test(file) || !runsDir || !existsSync(join(runsDir, file))) return null;
  try {
    return Exploration.parse(JSON.parse(readFileSync(join(runsDir, file), "utf-8")));
  } catch {
    return null;
  }
}

