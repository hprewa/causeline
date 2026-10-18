#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "@causeline/schema";
import { loadPackForRun, loadPlaybook } from "./load.js";
import { runPlaybook, type RunInputs } from "./runner.js";
import { SdkToolCaller } from "./toolcaller.js";

const USAGE = `usage: causeline run --pack <dir> --metric <name> --period <label> [options]
  --playbook <name>   playbook to run (default: metric_change)
  --baseline <n>      periods to compare against (default: 4)
  --url <url>         Toolbox server (default: http://127.0.0.1:5000)
  --out-dir <dir>     where result.json is written (default: runs)
  --set key=value     override a threshold or playbook input (repeatable)`;

function parseArgs(argv: string[]): { flags: Map<string, string>; sets: string[] } {
  const flags = new Map<string, string>();
  const sets: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) throw new Error(`bad argument "${key}"\n${USAGE}`);
    if (key === "--set") sets.push(value);
    else flags.set(key.slice(2), value);
  }
  return { flags, sets };
}

export function summarise(result: Result): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const num = (x: number) => x.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  // a rate prints as a percentage and points; anything else (a total, an average) in its own units
  const ratio = (result.headline?.format ?? "fraction") === "fraction";
  const lines: string[] = [];
  if (result.headline) {
    const h = result.headline;
    const sign = h.change >= 0 ? "+" : "";
    lines.push(
      ratio
        ? `${h.metric}: ${pct(h.value)} vs baseline ${pct(h.baseline)} (${sign}${(h.change * 100).toFixed(2)} pts)`
        : `${h.metric}: ${num(h.value)} vs baseline ${num(h.baseline)} per period (${sign}${num(h.change)})`,
    );
  }
  for (const d of result.drivers ?? []) {
    lines.push(`  driver ${d.metric}: ${num(d.baseline)} -> ${num(d.value)}${d.share === null ? "" : `, ${(d.share * 100).toFixed(0)}% of the change`}${d.metric === result.drilled_driver ? "  <- drilled" : ""}`);
  }
  if (result.window) lines.push(`window: ${result.window.start} .. ${result.window.end}${result.onset ? `  onset: ${result.onset}` : ""}`);
  if (result.status === "stopped") lines.push(`STOPPED (${result.stopped_reason}): ${result.stopped_detail}`);
  for (const f of result.findings) {
    const where = f.scope ? ` @ ${Object.entries(f.scope).map(([k, v]) => `${k}=${v}`).join(", ")}` : "";
    const impact = (f.metric ? result.headline?.metric !== f.metric : false) || !ratio ? num(f.impact) : `${(f.impact * 100).toFixed(2)} pts`;
    lines.push(`  #${f.rank} ${f.dimension}=${f.value}${where}  impact ${impact}${f.metric && f.metric !== result.headline?.metric ? ` (${f.metric})` : ""}${f.persistence ? `  [${f.persistence}]` : ""}${f.effect === "mix" ? "  [mix]" : ""}`);
  }
  for (const f of result.masking_flags) lines.push(`  masking: ${f.type} at ${f.level}${f.node ? ` (${f.node})` : ""}: ${f.detail ?? ""}`);
  return lines.join("\n");
}

export async function runCli(argv: string[]): Promise<void> {
  const { flags, sets } = parseArgs(argv);
  const pack = flags.get("pack");
  const metric = flags.get("metric");
  const period = flags.get("period");
  if (!pack || !metric || !period) {
    console.error(USAGE);
    process.exit(2);
  }
  const inputs: RunInputs = { metric, period };
  if (flags.has("baseline")) inputs.baseline = flags.get("baseline")!;
  for (const kv of sets) {
    const [k, ...rest] = kv.split("=");
    const v = rest.join("=");
    inputs[k] = v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
  }

  const playbookName = flags.get("playbook") ?? "metric_change";
  const def = loadPackForRun(pack);
  const result = await runPlaybook({
    playbook: loadPlaybook(playbookName, pack),
    ontology: def.ontology,
    meta: def.meta,
    tools: new SdkToolCaller(flags.get("url")),
    inputs,
  });

  const outDir = flags.get("out-dir") ?? "runs";
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(outDir, `${stamp}-${playbookName}-${metric}-${period}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n", "utf-8");
  console.log(summarise(result));
  console.log(`\nresult: ${file}`);
}

if (process.argv[1] && /cli\.js$/.test(process.argv[1])) {
  runCli(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
