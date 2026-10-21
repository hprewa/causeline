import { branchesOf, loadPlaybook } from "@causeline/runner";
import { loadAgents } from "@causeline/schema";
import type { CaseOutcome } from "./table.js";

const passed = (o: CaseOutcome) => !!o.runner && "pass" in o.runner && o.runner.pass;

export interface BranchCoverage {
  playbook: string;
  total: number;
  /** Branches some passing case took. */
  covered: string[];
  untested: string[];
}

/** Which branches of each playbook the pack's passing cases take. A case that fails or has a known gap proves nothing. */
export function branchCoverage(outcomes: CaseOutcome[], packDir: string, coreDir?: string): BranchCoverage[] {
  const names = [...new Set(outcomes.map((o) => o.playbook).filter((p): p is string => !!p))];
  return names.map((playbook) => {
    const all = branchesOf(loadPlaybook(playbook, packDir, coreDir));
    const taken = new Set(outcomes.filter((o) => o.playbook === playbook && !o.gap && passed(o)).flatMap((o) => o.branches ?? []));
    return { playbook, total: all.length, covered: all.filter((b) => taken.has(b)), untested: all.filter((b) => !taken.has(b)) };
  });
}

/** Experts marked `verified` whose playbook has a branch no passing case takes: they cannot honestly keep the label. */
export function expertsWithUntestedBranches(coverage: BranchCoverage[], packDir: string): { expert: string; playbook: string; untested: string[] }[] {
  return loadAgents(packDir)
    .filter((a) => a.status === "verified")
    .flatMap((a) => {
      const playbook = a.playbook ?? (a.task === "deep_rca" ? "metric_change" : a.task);
      const c = coverage.find((x) => x.playbook === playbook);
      return c && c.untested.length > 0 ? [{ expert: a.name, playbook, untested: c.untested }] : [];
    });
}

export function renderCoverage(coverage: BranchCoverage[], flagged: ReturnType<typeof expertsWithUntestedBranches>): string {
  const lines = coverage.map((c) => `branches of ${c.playbook}: ${c.covered.length}/${c.total} taken by a passing case${c.untested.length > 0 ? `; never taken: ${c.untested.join(", ")}` : ""}`);
  for (const f of flagged) lines.push(`  ${f.expert} is marked verified, but ${f.untested.length} branch(es) of ${f.playbook} are never taken by a passing case`);
  return lines.join("\n");
}
