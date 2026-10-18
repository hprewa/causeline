import { resolve } from "node:path";
import { SdkToolCaller, ToolboxProcess } from "@causeline/runner";
import { routeWithData } from "./context.js";

const USAGE = `usage: causeline route "<question>" --pack <dir> [--url <toolbox url>] [--json]
  Says which KPI, task and expert fit a plain question, resolves the period, and what it would ask.`;

/** `causeline route`: the router's decision for one question, in words (or JSON). */
export async function runRouteCli(argv: string[]): Promise<void> {
  const question = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && argv[i - 1] !== "--json"));
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pack = flag("pack");
  if (!question || !pack) throw new Error(USAGE);
  const packDir = resolve(pack);
  let server: ToolboxProcess | undefined;
  try {
    let url = flag("url");
    if (!url) {
      server = await ToolboxProcess.start({ cwd: packDir, configDir: "toolbox" });
      url = server.url;
    }
    const r = await routeWithData({ packDir, question, tools: new SdkToolCaller(url) });
    if (argv.includes("--json")) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.log(r.announce);
    console.log(`strategy: ${r.strategy}${r.scan ? ` (period ${r.scan.period})` : ""}`);
    for (const o of r.options.slice(0, 3)) {
      console.log(`  ${o.expert}${o.kpi ? ` [${o.kpi} / ${o.task}]` : ""} ${o.status} confidence ${o.confidence}${o.playbook ? ` playbook ${o.playbook}` : ""} ${JSON.stringify(o.inputs)}`);
      for (const reason of o.reasons) console.log(`      - ${reason}`);
    }
    if (r.needs) console.log(`asks: ${r.needs.question}${r.needs.choices ? ` (${r.needs.choices.join(", ")})` : ""}`);
  } finally {
    await server?.stop();
  }
}
