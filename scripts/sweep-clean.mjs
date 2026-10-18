#!/usr/bin/env node
// False-positive sweep: run the metric_change playbook over every period of every (non-product)
// metric on CLEAN data and count the periods that report anything. With --naive the ontology's
// seasonality is switched off in the runner, which is what the harness did before sprint 5.
//   node scripts/sweep-clean.mjs <prepared pack dir> [--naive] [--metrics a,b]
// The pack dir must hold ontology.yaml, toolbox/ and data/causeline.db for a fault-free dataset, for
// example runs/eval-work/contact-centre/clean_week after `causeline eval --case clean_week`.
import { resolve } from "node:path";
import { loadPackForRun, loadPlaybook, runPlaybook, SdkToolCaller, ToolboxProcess, ToolIndex } from "../core/runner/dist/src/index.js";
import { toBuckets } from "../core/runner/dist/src/rows.js";

const args = process.argv.slice(2);
const pack = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const naive = args.includes("--naive");
const only = args.includes("--metrics") ? args[args.indexOf("--metrics") + 1].split(",") : null;

const { ontology, meta } = loadPackForRun(pack);
const index = new ToolIndex(meta);
if (naive) ontology.time.seasonality = "none";
const playbook = loadPlaybook("metric_change", pack);
const server = await ToolboxProcess.start({ cwd: pack, configDir: "toolbox" });
try {
  const tools = new SdkToolCaller(server.url);
  const top = ontology.time.levels[0];
  const metrics = Object.entries(ontology.metrics).filter(([name, m]) => m.type !== "product" && (!only || only.includes(name)));
  let totalWrong = 0;
  let total = 0;
  for (const [metric] of metrics) {
    const counts = (await tools.call(index.extent(metric), {}, "sweep"))[0];
    const series = toBuckets(await tools.call(index.series(metric, top), { start: String(counts.min_ts), end: String(counts.max_ts) }, "sweep"));
    const wrong = [];
    for (let i = 1; i < series.length; i++) {
      const label = series[i].bucket;
      const r = await runPlaybook({ playbook, ontology, meta, tools, inputs: { metric, period: label, baseline: Math.min(4, i) } });
      const what = [];
      if (r.status === "stopped") what.push(`stopped:${r.stopped_reason}`);
      for (const f of r.findings) what.push(`${f.dimension}=${f.value}`);
      for (const f of r.masking_flags) what.push(`flag:${f.type}`);
      if (what.length > 0) wrong.push(`${label} [${what.slice(0, 3).join(", ")}]`);
    }
    const n = series.length - 1;
    total += n;
    totalWrong += wrong.length;
    console.log(`${metric}: ${wrong.length} / ${n} periods wrong${wrong.length ? "\n  " + wrong.join("\n  ") : ""}`);
  }
  console.log(`${naive ? "naive" : "seasonal"} total: ${totalWrong} / ${total}`);
} finally {
  await server.stop();
}
process.exit(0);
