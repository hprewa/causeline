import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { completePeriods, routeWithData } from "@causeline/router";
import { loadPackForRun, SdkToolCaller, ToolboxProcess, ToolIndex } from "@causeline/runner";
import { RoutingCases, type Route, type RoutingCase } from "@causeline/schema";
import { loadCases } from "./cases.js";
import { prepareCase } from "./prepare.js";

/** A routing eval is a list of realistic questions and where each should go: <pack>/evals/routing.yaml. */
export function loadRoutingCases(packDir: string): RoutingCase[] {
  const file = join(packDir, "evals", "routing.yaml");
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const parsed = RoutingCases.safeParse(parse(readFileSync(file, "utf-8")));
  if (!parsed.success) throw new Error(`${file} is not valid:\n` + parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  return parsed.data;
}

export interface RoutingOutcome {
  question: string;
  pass: boolean;
  misses: string[];
  route: Route;
}

/** What was expected against what the router said. An expectation left out is not checked, except `needs`: no `needs` means it must not ask. */
export function scoreRouting(r: Route, e: RoutingCase["expect"]): { pass: boolean; misses: string[] } {
  const top = r.options[0];
  const misses: string[] = [];
  const check = (what: string, want: unknown, got: unknown) => {
    if (want !== undefined && want !== got) misses.push(`${what}: expected ${want}, got ${got ?? "none"}`);
  };
  check("strategy", e.strategy ?? "expert", r.strategy);
  if (r.strategy === "explorer" && e.strategy === "explorer") {
    check("kpi", e.kpi, top?.kpi);
    check("op", e.op, top?.inputs.op);
    check("period", e.period, top?.inputs.period);
    return { pass: misses.length === 0, misses };
  }
  check("kpi", e.kpi, top?.kpi);
  check("task", e.task, top?.task);
  check("expert", e.expert, top?.expert);
  check("period", e.period, r.scan?.period ?? top?.inputs.period);
  check("needs", e.needs ?? null, r.needs?.input ?? null);
  return { pass: misses.length === 0, misses };
}

export interface RoutingEvalOptions {
  packDir: string;
  workRoot: string;
  toolbox?: string;
  log?: (line: string) => void;
}

/** Route every question of the pack's routing eval against the pack's own (clean) data. */
export async function runRoutingEval(opts: RoutingEvalOptions): Promise<RoutingOutcome[]> {
  const log = opts.log ?? (() => {});
  const cases = loadRoutingCases(opts.packDir);
  // routing needs real period labels, so build the pack once from a case that plants nothing
  const all = loadCases(opts.packDir);
  const base = all.find((c) => c.expect.no_findings) ?? all[0];
  log(`[routing] preparing ${base.id}`);
  const workDir = await prepareCase(opts.packDir, base, resolve(opts.workRoot), false);
  const server = await ToolboxProcess.start({ cwd: workDir, configDir: "toolbox", binary: opts.toolbox });
  try {
    const tools = new SdkToolCaller(server.url);
    const out: RoutingOutcome[] = [];
    const pack = loadPackForRun(workDir);
    const periods = await completePeriods(tools, new ToolIndex(pack.meta), Object.keys(pack.data.metrics)[0], pack.ontology.time.levels[0]);
    for (const c of cases) {
      const route = await routeWithData({ packDir: workDir, question: c.question, tools, periods });
      out.push({ question: c.question, route, ...scoreRouting(route, c.expect) });
    }
    return out;
  } finally {
    await server.stop();
  }
}

export function renderRouting(outcomes: RoutingOutcome[]): string {
  const passed = outcomes.filter((o) => o.pass).length;
  const lines = outcomes.map((o) => `${o.pass ? "pass" : "MISS"}  ${o.question}${o.pass ? "" : "\n        " + o.misses.join("; ") + `\n        routed to: ${o.route.announce}`}`);
  return [...lines, "", `routing score: ${passed}/${outcomes.length} (${Math.round((passed / Math.max(1, outcomes.length)) * 100)}%)`].join("\n");
}
